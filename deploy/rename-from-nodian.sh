#!/usr/bin/env bash
# Move an install from the old data names (nodian) to the new ones (inkling): compose project, volumes,
# database role and database (docs/adr/2341-*, docs/OPERATIONS.md "Upgrading to 0.19").
#
#   ./deploy/rename-from-nodian.sh --dry-run    # plan, sizes, free disk, expected downtime; changes nothing
#   ./deploy/rename-from-nodian.sh              # do it (asks once; --yes does not ask)
#   ./deploy/rename-from-nodian.sh --rollback   # back to the old names, at any point
#
# Use the same compose files as for every other command: compose.override.yaml is read as usual, or
#   COMPOSE="docker compose -f compose.yaml -f deploy/compose.caddy.yaml" ./deploy/rename-from-nodian.sh
#
# Steps: pre-rename backup (backup sidecar, else pg_dump into ./backups/) -> stop the app -> record row
# counts -> stop the stack -> COPY every old-name volume into a new-name volume (the old volumes are only
# read, never changed or deleted) -> rename the role and database inside the copy -> INKLING_DATA_NAME in
# .env -> start under the new names -> compare counts, /api/health/ready, a backup with the new names.
# Interrupted or failed: run it again and it continues; or --rollback starts the old names again.
# State and the copy of .env it changes: ./backups/rename-<from>-to-<to>/.
set -euo pipefail
cd "$(dirname "$0")/.."

FROM=nodian TO=inkling DRY=0 YES=0 MODE=forward SKIP_BACKUP_CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    --rollback) MODE=rollback ;;
    --skip-backup-check) SKIP_BACKUP_CHECK=1 ;;
    # Test knobs (the upgrade test runs next to a real `nodian` stack): other old/new names.
    --from) FROM="$2"; shift ;;
    --to) TO="$2"; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

read -r -a DC <<<"${COMPOSE:-docker compose}"
STATE_DIR="backups/rename-$FROM-to-$TO"
STATE="$STATE_DIR/state"
TMP_ROLE=inkling_rename_tmp
LABEL=io.inkling.renamed-from

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

need docker
need perl
docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required ("docker compose version" fails)'

# --- .env (read with sed, never sourced) ----------------------------------------------------------
env_get() {
  [ -f .env ] || return 0
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*[\"']?([^\"'#]*).*/\1/p" .env | tr -d '\r' | tail -n 1 | sed -E 's/[[:space:]]+$//'
}
env_set() { # KEY VALUE: replace the KEY= line(s) in .env, or append one
  local tmp
  tmp=$(mktemp .env.rename.XXXXXX)
  awk -v k="$1" -v v="$2" '
    $0 ~ "^[[:space:]]*" k "[[:space:]]*=" { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' .env >"$tmp"
  cat "$tmp" >.env # keeps the file's owner and mode
  rm -f "$tmp"
}

# --- compose in either naming ---------------------------------------------------------------------
# COMPOSE_PROJECT_NAME=<old name> in .env (rare) would keep the old project name; the new side gets the
# new one, and .env is changed with INKLING_DATA_NAME.
ENV_PROJECT=$(env_get COMPOSE_PROJECT_NAME)
PROJECT_CHANGED=0 # set when this script changed COMPOSE_PROJECT_NAME=<old> in .env to the new name
[ -f "$STATE_DIR/project-changed" ] && PROJECT_CHANGED=1
dc_old() {
  if [ "$PROJECT_CHANGED" = 1 ]; then COMPOSE_PROJECT_NAME="$FROM" INKLING_DATA_NAME="$FROM" "${DC[@]}" "$@"
  else INKLING_DATA_NAME="$FROM" "${DC[@]}" "$@"; fi
}
dc_new() {
  if [ "$ENV_PROJECT" = "$FROM" ] || [ "$PROJECT_CHANGED" = 1 ]; then COMPOSE_PROJECT_NAME="$TO" INKLING_DATA_NAME="$TO" "${DC[@]}" "$@"
  else INKLING_DATA_NAME="$TO" "${DC[@]}" "$@"; fi
}

# "name <project>", "dbimage <image>", "vol <key> <name> <external 0|1>" from `compose config`
describe() {
  perl -MJSON::PP -e '
    my $d = decode_json(join "", <STDIN>);
    print "name\t$d->{name}\n";
    print "dbimage\t", ($d->{services}{db}{image} // ""), "\n";
    my $v = $d->{volumes} || {};
    for my $k (sort keys %$v) {
      my $e = $v->{$k}{external} ? 1 : 0;
      print "vol\t$k\t", ($v->{$k}{name} // ""), "\t$e\n";
    }'
}
CFG_OLD=$(dc_old config --format json 2>"${TMPDIR:-/tmp}/rename-cfg.err" | describe) || {
  cat "${TMPDIR:-/tmp}/rename-cfg.err" >&2
  die "docker compose cannot read the configuration with the old names (above). An override that names volumes like $FROM-data needs the new keys: data, db, backups, backup-ctl (compose.yaml)."
}
CFG_NEW=$(dc_new config --format json 2>/dev/null | describe) || die 'docker compose cannot read the configuration with the new names'
P_OLD=$(printf '%s\n' "$CFG_OLD" | awk -F'\t' '$1 == "name" { print $2 }')
P_NEW=$(printf '%s\n' "$CFG_NEW" | awk -F'\t' '$1 == "name" { print $2 }')
PG_IMAGE=$(printf '%s\n' "$CFG_OLD" | awk -F'\t' '$1 == "dbimage" { print $2 }')
[ -n "$PG_IMAGE" ] || die 'no db service in the compose configuration'
# old-name -> new-name pairs: every volume whose name changes (external volumes keep theirs)
PAIRS=$(printf '%s\n%s\n' "$CFG_OLD" "$CFG_NEW" | awk -F'\t' '
  $1 == "vol" && !($2 in old) { old[$2] = $3; ext[$2] = $4; next }
  $1 == "vol" && ($2 in old) && old[$2] != $3 && ext[$2] == 0 { print $2 "\t" old[$2] "\t" $3 }')
DB_OLD=$(printf '%s\n' "$PAIRS" | awk -F'\t' '$1 == "db" { print $2 }')
DB_NEW=$(printf '%s\n' "$PAIRS" | awk -F'\t' '$1 == "db" { print $3 }')

# Start with the image that is there: never build or pull a different version during the rename.
UP=(up -d --no-build)
docker compose up --help 2>/dev/null | grep -q -- '--pull' && UP+=(--pull never)

vol_exists() { docker volume inspect "$1" >/dev/null 2>&1; }
helper() { docker run --rm --network none "$@"; } # always the db service's own image
running_services() { "$@" ps --status running --services 2>/dev/null || true; }

# --- which stack is this? (never act on a same-named project of another directory) ----------------
HERE=$(pwd -P)
dirs_of_project() {
  docker ps -a --filter "label=com.docker.compose.project=$1" \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' | sort -u
}
check_owner() {
  local p=$1 d
  for d in $(dirs_of_project "$p"); do
    [ "$d" = "$HERE" ] && continue
    [ -d "$d" ] && [ "$(cd "$d" && pwd -P)" = "$HERE" ] && continue # same folder through a symlink
    [ "${INKLING_RENAME_ANY_DIR:-0}" = 1 ] && { warn "project $p was started from $d (INKLING_RENAME_ANY_DIR=1)"; continue; }
    die "compose project '$p' on this machine was started from $d, not from $HERE. Run this script from that directory (or set INKLING_RENAME_ANY_DIR=1 if the install was moved)."
  done
}

# --- state ------------------------------------------------------------------------------------------
has() { [ -f "$STATE" ] && grep -qx "$1" "$STATE"; }
mark() { [ "$DRY" = 1 ] && return 0; mkdir -p "$STATE_DIR"; echo "$1" >>"$STATE"; }
test_kill() { # the upgrade test interrupts the run here, the hard way (no traps)
  if [ "${INKLING_RENAME_TEST_KILL:-}" = "$1" ]; then
    warn "test: killed after $1"
    kill -KILL $$
  fi
}

# --- sizes and estimates -----------------------------------------------------------------------------
vol_kb() { helper -v "$1":/v:ro "$PG_IMAGE" du -sk /v | awk '{ print $1 }'; }
free_kb() { helper -v "$1":/v:ro "$PG_IMAGE" df -Pk /v | awk 'NR == 2 { print $4 }'; }
human() { awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1f GB", k / 1048576; else printf "%.0f MB", k / 1024 + 0.5 }'; }

# --- database helpers ----------------------------------------------------------------------------
# Every table's row count, "schema.table count" sorted, in one query.
COUNTS_SQL="select table_schema || '.' || table_name || ' ' ||
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
  from information_schema.tables where table_type = 'BASE TABLE' and table_schema in ('public', 'drizzle') order by 1"
HEADLINE_SQL="select 'migrations ' || (select count(*) from drizzle.__drizzle_migrations)
  union all select 'accounts ' || (select count(*) from users)
  union all select 'pages ' || (select count(*) from pages)
  union all select 'collection_rows ' || (select count(*) from pages p join pages c on c.id = p.parent_id and c.kind = 'collection')
  union all select 'share_links ' || (select count(*) from pages where share_token is not null)
  union all select 'files ' || (select count(*) from files)"
# psql in a compose db container, with the role and database of that container
dc_psql() { local dcf=$1; shift; "$dcf" exec -T db sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -AtX -v ON_ERROR_STOP=1 "$@"' psql "$@"; }
data_files() { helper -v "$1":/v:ro "$PG_IMAGE" sh -c 'find /v -type f | wc -l' | tr -d ' '; }
ready() { # $1 = dc_old | dc_new; prints /api/health/ready
  "$1" exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready 2>/dev/null
}
wait_ready() {
  local i out
  for i in $(seq 1 90); do
    out=$(ready "$1") && { printf '%s' "$out"; return 0; }
    sleep 2
  done
  return 1
}
wait_db() {
  local i
  for i in $(seq 1 60); do
    dc_psql "$1" -c 'select 1' >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# --- temporary server on the copied database volume ---------------------------------------------
RENAME_PG="$P_NEW-rename-pg"
pg_tmp_start() {
  docker rm -f "$RENAME_PG" >/dev/null 2>&1 || true
  # Unix socket only (--network none, listen_addresses empty) with an hba file of its own that trusts
  # local connections, so the copy's pg_hba.conf and passwords play no part here.
  docker run -d --name "$RENAME_PG" --label io.inkling.rename=1 --network none \
    -v "$DB_NEW":/var/lib/postgresql/data "$PG_IMAGE" sh -c '
      printf "local all all trust\n" >/tmp/rename_hba.conf && chmod 644 /tmp/rename_hba.conf &&
      exec docker-entrypoint.sh postgres -c listen_addresses= -c hba_file=/tmp/rename_hba.conf' >/dev/null
  local i
  for i in $(seq 1 60); do
    docker exec "$RENAME_PG" pg_isready -q -h /var/run/postgresql >/dev/null 2>&1 && return 0
    sleep 1
  done
  docker logs --tail 30 "$RENAME_PG" >&2 || true
  die "the temporary server on $DB_NEW did not start (log above)"
}
pg_tmp_stop() { docker stop -t 60 "$RENAME_PG" >/dev/null 2>&1 || true; docker rm -f "$RENAME_PG" >/dev/null 2>&1 || true; }
# psql on the temporary server as role $1 in database $2 (SQL on stdin or -c)
tpsql() { local u=$1 d=$2; shift 2; docker exec -i -e PGPW -u postgres "$RENAME_PG" psql -h /var/run/postgresql -U "$u" -d "$d" -AtX -v ON_ERROR_STOP=1 "$@"; }
role_exists() { [ "$(tpsql "$1" postgres -c "select 1" 2>/dev/null || true)" = 1 ]; }

# ======================================================================================================
# rollback
# ======================================================================================================
if [ "$MODE" = rollback ]; then
  check_owner "$P_NEW"
  say "back to the old names: project $P_OLD, INKLING_DATA_NAME=$FROM"
  [ -n "$DB_OLD" ] && vol_exists "$DB_OLD" || die "the old database volume ${DB_OLD:-?} does not exist: nothing to go back to"
  if [ "$DRY" = 1 ]; then
    info "[dry-run] ${DC[*]} down (new names, volumes kept)"
    info "[dry-run] .env: INKLING_DATA_NAME=$FROM"
    info "[dry-run] ${DC[*]} up -d (old names)"
    exit 0
  fi
  pg_tmp_stop
  dc_new down >/dev/null 2>&1 || true
  [ -f .env ] && env_set INKLING_DATA_NAME "$FROM"
  if [ "$PROJECT_CHANGED" = 1 ]; then env_set COMPOSE_PROJECT_NAME "$FROM"; rm -f "$STATE_DIR/project-changed"; fi
  mkdir -p "$STATE_DIR"
  [ -f "$STATE" ] && mv "$STATE" "$STATE_DIR/state.rolled-back.$(date +%Y%m%d-%H%M%S)"
  say "starting the old stack"
  dc_old "${UP[@]}"
  r=$(wait_ready dc_old) || die "the app did not become ready under the old names: ${DC[*]} logs app"
  info "health/ready: $r"
  say "rolled back. The old volumes were never changed; anything written under the new names since the"
  info "rename is only in the new volumes, which stay until the next run of this script replaces them."
  exit 0
fi

# ======================================================================================================
# forward: preflight
# ======================================================================================================
say "rename $FROM -> $TO in $HERE"
CUR=$(env_get INKLING_DATA_NAME)
[ -f .env ] || die "no .env here. Run this from the directory that holds compose.yaml and .env"
case "$CUR" in
  "" | "$FROM") ;;
  "$TO")
    if has done; then say "already done (INKLING_DATA_NAME=$TO, $STATE)"; exit 0; fi
    has switched || {
      # .env says the new name but this script never switched it: a new install, or a hand edit.
      [ -n "$DB_OLD" ] && vol_exists "$DB_OLD" ||
        { say "INKLING_DATA_NAME=$TO and no old-name volumes: nothing to do"; exit 0; }
      die "INKLING_DATA_NAME=$TO is set but $DB_OLD still exists. If .env was edited by hand, set INKLING_DATA_NAME=$FROM again and run this script; if the new names already hold data you want, nothing needs moving."
    } ;;
  *) die "INKLING_DATA_NAME=$CUR in .env; this script moves $FROM -> $TO" ;;
esac
[ -n "$DB_OLD" ] || die "the database volume does not change name between $FROM and $TO (COMPOSE_PROJECT_NAME/-p and volume names?)"
check_owner "$P_OLD"
[ "$P_NEW" = "$P_OLD" ] || check_owner "$P_NEW"
vol_exists "$DB_OLD" || has copied:"$DB_NEW" || die "the old database volume $DB_OLD does not exist: there is no $FROM install here"

info "compose project $P_OLD -> $P_NEW, database role and database $FROM -> $TO"
info "compose command: ${DC[*]}${COMPOSE_FILE:+ (COMPOSE_FILE=$COMPOSE_FILE)}"

# Old stack started again after an interrupted run (or a rollback): start over, the copies are stale.
OLD_RUNNING=$(running_services dc_old)
if [ -f "$STATE" ] && ! has done && printf '%s\n' "$OLD_RUNNING" | grep -qx app; then
  if has stopped; then
    warn "the old stack runs again since the interrupted run: starting over (the new volumes are copied again)"
    [ "$DRY" = 1 ] || mv "$STATE" "$STATE_DIR/state.restarted.$(date +%Y%m%d-%H%M%S)"
  fi
fi
[ -f "$STATE" ] && info "continuing an earlier run: $(tr '\n' ' ' <"$STATE")"

# Volumes, sizes, free space, downtime
say "volumes (copied; the old ones stay as they are)"
TOTAL_KB=0
DB_KB=0
TODO_KB=0 # not copied yet (a second run needs room only for what is left)
while IFS="$(printf '\t')" read -r key old new; do
  [ -n "$key" ] || continue
  if ! vol_exists "$old"; then
    info "$old does not exist (nothing to copy for '$key')"
    continue
  fi
  drv=$(docker volume inspect -f '{{.Driver}} {{len .Options}}' "$old")
  [ "$drv" = "local 0" ] || die "volume $old uses driver/options '$drv' (a bind mount or another driver). Move it by hand: see docs/OPERATIONS.md \"Upgrading to 0.19\""
  kb=$(vol_kb "$old")
  TOTAL_KB=$((TOTAL_KB + kb))
  [ "$key" = db ] && DB_KB=$kb
  state=''
  if has "copied:$new"; then state=' (copied already)'; else TODO_KB=$((TODO_KB + kb)); fi
  info "$(printf '%-34s -> %-34s %8s' "$old" "$new" "$(human "$kb")")$state"
done <<<"$PAIRS"
FREE_KB=$(free_kb "$DB_OLD")
DUMP_KB=$DB_KB
has dumped && DUMP_KB=0
NEED_KB=$((TODO_KB + DUMP_KB + 262144))
info "total $(human "$TOTAL_KB"); free on the Docker disk $(human "$FREE_KB"); needed: the copies $(human "$TOTAL_KB") + a pre-rename dump (at most $(human "$DB_KB")) + 256 MB"
[ "$FREE_KB" -ge "$NEED_KB" ] || die "not enough free disk space: $(human "$FREE_KB") free, $(human "$NEED_KB") needed"
[ "$FREE_KB" -ge $((TOTAL_KB * 2)) ] || warn "less free space than twice the volumes ($(human $((TOTAL_KB * 2)))): the copy fits, but little is left afterwards"
# downtime: app stop (<= 30 s) + dump and copy at a conservative 50 MB/s + rename + boot (~60 s)
EST=$((30 + DB_KB / 51200 + TOTAL_KB / 51200 + 20 + 60))
info "expected downtime: about $(( (EST + 59) / 60 )) min (app stop, dump, copy $(human "$TOTAL_KB"), rename, start)"

# Other files that may name old volumes (compose files of COMPOSE / COMPOSE_FILE and the override)
files=$({
  printf '%s\n' "${COMPOSE_FILE:-}" "$(env_get COMPOSE_FILE)" | tr ':' '\n'
  printf '%s\n' "${DC[@]}" | grep -E '\.ya?ml$' || true
  ls compose.override.yaml compose.override.yml docker-compose.override.yml 2>/dev/null || true
} | grep -v '^$' | sort -u)
for f in $files; do
  [ -f "$f" ] || continue
  case "$f" in compose.yaml|./compose.yaml|deploy/compose.backup-rclone.yaml|deploy/compose.caddy.yaml|compose.local.yaml|compose.build.yaml) continue ;; esac
  if grep -n -E "(^|[^A-Za-z0-9_])$FROM([^A-Za-z0-9_]|$)" "$f" >/dev/null; then
    warn "$f mentions '$FROM'; check these lines after the rename:"
    grep -n -E "(^|[^A-Za-z0-9_])$FROM([^A-Za-z0-9_]|$)" "$f" | sed 's/^/      /' >&2
  fi
done
for c in $(docker ps -a --format '{{.Names}}' | grep -E "^$P_OLD-" || true); do
  p=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c")
  [ "$p" = "$P_OLD" ] || warn "container $c is not part of the compose project but carries its name; scripts that call it by name need the new one"
done

# `down` removes the project's networks; a container of another stack attached to one would make it fail.
for net in $(docker network ls -q --filter "label=com.docker.compose.project=$P_OLD"); do
  for c in $(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$net"); do
    p=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c" 2>/dev/null || true)
    [ "$p" = "$P_OLD" ] && continue
    msg="container $c (not in project $P_OLD) is attached to network $(docker network inspect -f '{{.Name}}' "$net"); disconnect it first: docker network disconnect $(docker network inspect -f '{{.Name}}' "$net") $c"
    if [ "$DRY" = 1 ]; then warn "$msg"; else die "$msg"; fi
  done
done

if [ "$DRY" = 1 ]; then
  say "plan (dry run: nothing was changed)"
  info "1. pre-rename backup: backup sidecar (./deploy/backup.sh), else pg_dump into $STATE_DIR/"
  info "2. ${DC[*]} stop app; record row counts of every table, file count of the data volume"
  info "3. ${DC[*]} down (old names; volumes are kept)"
  info "4. copy each volume above into its new name (docker run $PG_IMAGE cp -a), compare file counts"
  info "5. temporary Postgres on the copy: ALTER ROLE $FROM RENAME TO $TO, password from .env, ALTER DATABASE $FROM RENAME TO $TO; compare row counts"
  info "6. .env: INKLING_DATA_NAME=$TO (a copy of the old .env goes to $STATE_DIR/env.before)"
  info "7. ${DC[*]} up -d (new names); compare counts and /api/health/ready; one backup through the sidecar"
  info "Back to the old names at any point: $0 --rollback"
  exit 0
fi

if [ "$YES" = 0 ] && [ ! -f "$STATE" ]; then
  echo
  echo "The app stops for the downtime above. The old volumes are not changed or deleted."
  read -r -p "Continue? [y/N] " a
  [ "$a" = y ] || [ "$a" = Y ] || die aborted
fi
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
trap 'rc=$?; [ $rc = 0 ] || { pg_tmp_stop; printf "\nStopped with an error. Run %s again to continue, or %s --rollback to start the old names again.\n" "$0" "$0" >&2; }' EXIT

# ======================================================================================================
# 1-3. backup, counts, stop
# ======================================================================================================
if ! has stopped; then
  [ -f "$STATE_DIR/env.before" ] || { cp -p .env "$STATE_DIR/env.before"; chmod 600 "$STATE_DIR/env.before"; }
  if ! printf '%s\n' "$(running_services dc_old)" | grep -qx db; then
    say "starting the old database"
    dc_old "${UP[@]}" db
  fi
  wait_db dc_old || die "the old database does not answer"
  if printf '%s\n' "$(running_services dc_old)" | grep -qx app; then
    r=$(ready dc_old || true)
    info "health/ready before: ${r:-no answer}"
    printf '%s\n' "$r" >"$STATE_DIR/ready.before"
    say "stopping the app (it saves open documents first, up to 30 s)"
    dc_old stop app
  fi
  if ! has dumped; then
    say "pre-rename backup"
    if printf '%s\n' "$(running_services dc_old)" | grep -qx backup; then
      dc_old exec -T backup bash /scripts/backup-run.sh --kind manual --no-remote --no-restore-test --no-prune ||
        die "the pre-rename backup failed; nothing was changed"
      info "(a set in the old backups volume, which is copied too; ./deploy/backup.sh list shows it)"
    else
      f="$STATE_DIR/pre-rename-$(date +%Y%m%d-%H%M%S).dump"
      dc_old exec -T db sh -c 'exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >"$f" || die "pg_dump failed; nothing was changed"
      n=$(dc_old exec -T db pg_restore --list <"$f" | grep -c ';' || true)
      [ "$n" -gt 0 ] || die "the dump $f is unreadable"
      chmod 600 "$f"
      info "no backup sidecar running: pg_dump -> $f ($(human $(( $(wc -c <"$f") / 1024 ))), $n entries)"
    fi
    mark dumped
  fi
  dc_psql dc_old -c "$COUNTS_SQL" >"$STATE_DIR/counts.before"
  dc_psql dc_old -c "$HEADLINE_SQL" >"$STATE_DIR/headline.before"
  info "recorded: $(tr '\n' ' ' <"$STATE_DIR/headline.before")"
  say "stopping the stack (old names; volumes are kept)"
  dc_old down
  mark stopped
fi
[ -f "$STATE_DIR/counts.before" ] || die "$STATE_DIR/counts.before is missing; run --rollback, then this script again"

# nothing may still use an old volume
while IFS="$(printf '\t')" read -r key old new; do
  [ -n "$key" ] && vol_exists "$old" || continue
  users=$(docker ps -q --filter "volume=$old")
  [ -z "$users" ] || die "volume $old is still in use by: $(docker ps --filter "volume=$old" --format '{{.Names}}' | tr '\n' ' ')"
done <<<"$PAIRS"
helper -v "$DB_OLD":/v:ro "$PG_IMAGE" sh -c 'test ! -e /v/postmaster.pid' ||
  die "$DB_OLD has a postmaster.pid: the old database did not shut down cleanly. Start the old stack (--rollback), check its log, and run this again."

# ======================================================================================================
# 4. copy the volumes
# ======================================================================================================
while IFS="$(printf '\t')" read -r key old new; do
  [ -n "$key" ] && vol_exists "$old" || continue
  if has "copied:$new" && vol_exists "$new"; then continue; fi
  if vol_exists "$new"; then
    from=$(docker volume inspect -f "{{index .Labels \"$LABEL\"}}" "$new")
    if [ "$from" != "$old" ]; then
      empty=$(helper -v "$new":/v:ro "$PG_IMAGE" sh -c 'ls -A /v | head -n 1')
      [ -z "$empty" ] || die "volume $new already exists and holds data that this script did not copy (for example a start with INKLING_DATA_NAME=$TO before the rename). Check it; if nothing in it is needed: docker volume rm $new, then run this again."
      docker volume rm "$new" >/dev/null
    fi
  fi
  if ! vol_exists "$new"; then
    docker volume create --label "com.docker.compose.project=$P_NEW" --label "com.docker.compose.volume=$key" \
      --label "$LABEL=$old" "$new" >/dev/null
  fi
  say "copying $old -> $new"
  helper -v "$old":/from:ro -v "$new":/to "$PG_IMAGE" sh -c '
    set -e
    find /to -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -a /from/. /to/
    a=$(cd /from && find . | wc -l); b=$(cd /to && find . | wc -l)
    sa=$(cd /from && find . -type f -exec stat -c %s {} + | awk "{ s += \$1 } END { print s + 0 }")
    sb=$(cd /to && find . -type f -exec stat -c %s {} + | awk "{ s += \$1 } END { print s + 0 }")
    [ "$a" = "$b" ] && [ "$sa" = "$sb" ] || { echo "copy differs: $a/$b entries, $sa/$sb bytes" >&2; exit 1; }
    echo "    $b entries, $sb bytes"' || die "copying $old failed"
  mark "copied:$new"
done <<<"$PAIRS"
test_kill after-copy

# ======================================================================================================
# 5. role and database names inside the copy
# ======================================================================================================
if ! has renamed; then
  say "renaming the role and database in $DB_NEW (the old volume keeps '$FROM')"
  PGPW=$(env_get POSTGRES_PASSWORD)
  export PGPW
  [ -n "$PGPW" ] || die "POSTGRES_PASSWORD is empty in .env"
  pg_tmp_start
  # connect as whichever of the two names exists, make a temporary superuser to do the renaming
  if role_exists "$FROM"; then BOOT=$FROM; elif role_exists "$TO"; then BOOT=$TO; else die "cannot connect to the copy $DB_NEW as $FROM or $TO: $(tpsql "$FROM" postgres -c 'select 1' 2>&1 | tail -n 1)"; fi
  tpsql "$BOOT" postgres -v r="$TMP_ROLE" <<'SQL' >/dev/null
select format('create role %I superuser login', :'r') where not exists (select 1 from pg_roles where rolname = :'r') \gexec
SQL
  # (psql variables are substituted in stdin scripts only, not in -c)
  pwtype=$(tpsql "$TMP_ROLE" postgres -v r="$BOOT" <<'SQL'
select case when rolpassword like 'SCRAM-SHA-256$%' then 'SCRAM-SHA-256 (survives the rename)'
  when rolpassword like 'md5%' then 'MD5 (cleared by the rename, set again from .env)' else 'none' end
  from pg_authid where rolname = :'r'
SQL
)
  info "password of '$BOOT': $pwtype"
  tpsql "$TMP_ROLE" postgres -v f="$FROM" -v t="$TO" <<'SQL' >/dev/null
select format('alter role %I rename to %I', :'f', :'t')
  where exists (select 1 from pg_roles where rolname = :'f') and not exists (select 1 from pg_roles where rolname = :'t') \gexec
SQL
  [ "$(tpsql "$TMP_ROLE" postgres -v f="$FROM" <<<"select count(*) from pg_roles where rolname = :'f'")" = 0 ] ||
    die "role $FROM still exists next to $TO in $DB_NEW; check it by hand"
  test_kill after-role
  # The app's password, from .env: an MD5 password is cleared by the rename, a SCRAM one is kept;
  # setting it again covers both. Read inside the container from PGPW, never on a command line.
  tpsql "$TMP_ROLE" postgres -v t="$TO" <<'SQL' >/dev/null
\set pw `printf '%s' "$PGPW"`
select format('alter role %I password %L', :'t', :'pw') \gexec
SQL
  tpsql "$TMP_ROLE" postgres -v f="$FROM" -v t="$TO" <<'SQL' >/dev/null
select format('alter database %I rename to %I', :'f', :'t')
  where exists (select 1 from pg_database where datname = :'f') and not exists (select 1 from pg_database where datname = :'t') \gexec
SQL
  [ "$(tpsql "$TMP_ROLE" postgres -v t="$TO" <<<"select count(*) from pg_database where datname = :'t'")" = 1 ] ||
    die "database $TO is missing in $DB_NEW after the rename"
  tpsql "$TO" postgres -v r="$TMP_ROLE" <<'SQL' >/dev/null
select format('drop role %I', :'r') where exists (select 1 from pg_roles where rolname = :'r') \gexec
SQL
  # Ownership follows the role (objects point at its OID); show it, and anything owned by someone else.
  info "$(tpsql "$TO" "$TO" -c "select 'database owner ' || pg_get_userbyid(datdba) from pg_database where datname = current_database()")"
  info "extensions: $(tpsql "$TO" "$TO" -c "select string_agg(extname || ' (' || pg_get_userbyid(extowner) || ')', ', ' order by extname) from pg_extension")"
  other=$(tpsql "$TO" "$TO" -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'drizzle') and pg_get_userbyid(c.relowner) <> current_user")
  [ "$other" = 0 ] || warn "$other tables, sequences or indexes in public/drizzle are owned by another role"
  # pg_hba.conf lines that name the old role or database (the image's default names none)
  hba=$(docker exec "$RENAME_PG" sh -c "grep -nwE '$FROM' /var/lib/postgresql/data/pg_hba.conf || true")
  if [ -n "$hba" ]; then
    docker exec "$RENAME_PG" sed -i -E "s/(^|[^A-Za-z0-9_])$FROM([^A-Za-z0-9_]|$)/\\1$TO\\2/g" /var/lib/postgresql/data/pg_hba.conf
    warn "pg_hba.conf of the copy named '$FROM'; changed to '$TO' in these lines: $hba"
  fi
  # same data as before the stop
  tpsql "$TO" "$TO" -c "$COUNTS_SQL" >"$STATE_DIR/counts.copy"
  diff "$STATE_DIR/counts.before" "$STATE_DIR/counts.copy" >/dev/null ||
    { diff "$STATE_DIR/counts.before" "$STATE_DIR/counts.copy" >&2 || true; die "row counts in the copy differ from the old database"; }
  info "row counts of $(wc -l <"$STATE_DIR/counts.copy" | tr -d ' ') tables match"
  pg_tmp_stop
  mark renamed
fi

# ======================================================================================================
# 6. .env
# ======================================================================================================
if ! has switched; then
  env_set INKLING_DATA_NAME "$TO"
  if [ "$ENV_PROJECT" = "$FROM" ]; then env_set COMPOSE_PROJECT_NAME "$TO"; : >"$STATE_DIR/project-changed"; fi
  info ".env: INKLING_DATA_NAME=$TO$([ "$ENV_PROJECT" = "$FROM" ] && echo ", COMPOSE_PROJECT_NAME=$TO") (old copy: $STATE_DIR/env.before)"
  mark switched
fi

# ======================================================================================================
# 7. start and check
# ======================================================================================================
say "starting under the new names (project $P_NEW)"
dc_new "${UP[@]}"
r=$(wait_ready dc_new) || die "the app did not become ready: ${DC[*]} logs app. Back to the old names: $0 --rollback"
info "health/ready: $r"
dc_psql dc_new -c "$HEADLINE_SQL" >"$STATE_DIR/headline.after"
# The exact check (every table) was made on the copy before the start. Now the app is live: people may
# add pages while this runs, so numbers may grow; fewer of anything, or other migrations, is a failure.
bad=$(awk 'NR == FNR { b[$1] = $2; next }
  ($1 == "migrations" && $2 != b[$1]) || $2 < b[$1] { printf "%s %s -> %s; ", $1, b[$1], $2 }' \
  "$STATE_DIR/headline.before" "$STATE_DIR/headline.after")
[ -z "$bad" ] || die "after the start: $bad Back to the old names: $0 --rollback"
info "before -> now: $(paste -d' ' "$STATE_DIR/headline.before" "$STATE_DIR/headline.after" | awk '{ printf "%s %s%s  ", $1, $2, ($4 == $2 ? "" : " -> " $4) }')"
DATA_OLD=$(printf '%s\n' "$PAIRS" | awk -F'\t' '$1 == "data" { print $2 }')
DATA_NEW=$(printf '%s\n' "$PAIRS" | awk -F'\t' '$1 == "data" { print $3 }')
if [ -n "$DATA_OLD" ] && vol_exists "$DATA_OLD"; then
  info "files in the data volume: $(data_files "$DATA_OLD") before, $(data_files "$DATA_NEW") now"
fi
if [ "$SKIP_BACKUP_CHECK" = 0 ] && printf '%s\n' "$(running_services dc_new)" | grep -qx backup; then
  say "one backup with the new names"
  dc_new exec -T backup bash /scripts/backup-run.sh --kind manual --no-remote --no-prune ||
    die "the backup sidecar failed under the new names: ${DC[*]} logs backup"
fi
mark done
trap - EXIT

say "done: $FROM -> $TO"
info "The old volumes are still there, unchanged. Back to them (losing what was written since):"
info "  $0 --rollback"
info "Once you are sure (a few days), delete them:"
olds=$(printf '%s\n' "$PAIRS" | awk -F'\t' 'NF == 3 { print $2 }' | while read -r v; do vol_exists "$v" && printf '%s ' "$v"; done)
info "  docker volume rm $olds"
