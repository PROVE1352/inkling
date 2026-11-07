#!/usr/bin/env bash
# Restore an Inkling backup set (database + data volume). CLI only, by design: there is no
# restore button in the web UI (docs/adr/0605-*).
#
#   ./deploy/restore.sh [options] <set-id | latest>
#     --dry-run          verify the set and print every step; change nothing
#     --yes              do not ask for confirmation
#     --stop-app         stop the app container first (and start it again afterwards)
#     --skip-pre-backup  do not take a safety backup of the current state first (not recommended)
#
#   COMPOSE="docker compose -f compose.yaml -f deploy/compose.caddy.yaml" ./deploy/restore.sh latest
#
# Steps: verify set -> migration check -> app must be stopped -> safety backup of the current
# state -> DROP/CREATE + pg_restore -> replace data volume contents -> verify row counts and
# file counts. The backup sidecar must be running (it holds the tools and the passphrase).
# See docs/BACKUP.md.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0 YES=0 STOP_APP=0 PRE=1 ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    --stop-app) STOP_APP=1 ;;
    --skip-pre-backup) PRE=0 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) ID="$1" ;;
  esac
  shift
done
[ -n "$ID" ] || { echo "usage: $0 [--dry-run] [--yes] [--stop-app] <set-id|latest>" >&2; exit 2; }

read -r -a DC <<<"${COMPOSE:-docker compose}"
say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then echo "    [dry-run] $*"; else "$@"; fi; }
helper() { "${DC[@]}" exec -T backup bash /scripts/restore-helper.sh "$@"; }
mget() { printf '%s' "$MANIFEST" | perl -MJSON::PP -e 'my $d=decode_json(join "",<STDIN>); my $v=$d; $v=(ref $v eq "HASH" ? $v->{$_} : undef) for split /\./, $ARGV[0]; print defined $v ? (JSON::PP::is_bool($v) ? ($v?"true":"false") : $v) : ""' "$1"; }

running_services() { "${DC[@]}" ps --status running --services 2>/dev/null || true; }
running_services | grep -x backup >/dev/null ||
  die "the backup service is not running. Start it first: ${DC[*]} up -d backup"

if [ "$ID" = latest ]; then ID=$(helper latest | tr -d '\r'); fi
[[ "$ID" =~ ^[0-9]{8}-[0-9]{6}$ ]] || die "no such backup set: '$ID'"

# 1. what is in the set ---------------------------------------------------------------------
MANIFEST=$(helper manifest "$ID") || die "backup set $ID not found"
say "backup set $ID"
echo "    created      $(mget createdAt) ($(mget kind))"
echo "    app version  $(mget app.version), migration $(mget app.migration)"
echo "    migrations   $(mget db.migrationsApplied) applied (last at $(mget db.lastMigrationAt))"
echo "    size         $(mget totalBytes) bytes, encrypted: $(mget encrypted)"
echo "    consistency  files archived $(mget consistency.gapSeconds)s after the DB snapshot"

say "verifying checksums and readability"
helper verify "$ID" || die "verification failed - not restoring"

# 2. migration compatibility ----------------------------------------------------------------
JOURNAL=apps/server/drizzle/meta/_journal.json
BACKUP_MIG=$(mget db.migrationsApplied)
if [ -f "$JOURNAL" ]; then
  CODE_MIG=$(grep -c '"tag"' "$JOURNAL")
  CODE_TAG=$(grep '"tag"' "$JOURNAL" | tail -n1 | sed 's/.*"tag": *"\([^"]*\)".*/\1/')
  if [ "$BACKUP_MIG" -gt "$CODE_MIG" ]; then
    warn "the backup has $BACKUP_MIG migrations but this checkout only knows $CODE_MIG ($CODE_TAG)."
    warn "It was made by a NEWER Inkling version. Check out that version before restoring, or the app may fail."
    [ "$YES" = 1 ] || [ "$DRY" = 1 ] || { read -r -p "Continue anyway? [y/N] " a; [ "$a" = y ] || exit 1; }
  elif [ "$BACKUP_MIG" -lt "$CODE_MIG" ]; then
    warn "the backup has $BACKUP_MIG migrations, this checkout has $CODE_MIG ($CODE_TAG):"
    warn "the app will apply the $((CODE_MIG - BACKUP_MIG)) newer migration(s) on its next start."
  else
    echo "    migrations match this checkout ($CODE_MIG, $CODE_TAG)"
  fi
else
  warn "$JOURNAL not found - cannot compare migration versions"
fi

# 3. the app must not be writing ----------------------------------------------------------------
if running_services | grep -x app >/dev/null; then
  if [ "$STOP_APP" = 1 ]; then
    say "stopping the app"
    run "${DC[@]}" stop app
  elif [ "$DRY" = 1 ]; then
    warn "the app is running - a real restore requires '${DC[*]} stop app' or --stop-app"
  else
    die "the app is running. Stop it first ('${DC[*]} stop app') or pass --stop-app"
  fi
fi

# where the data volume lives (named volume or bind mount of the backup container's /data)
CID=$("${DC[@]}" ps -q backup)
DATA_SRC=$(docker inspect "$CID" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}')
IMAGE=$(docker inspect "$CID" --format '{{.Config.Image}}')
[ -n "$DATA_SRC" ] || die "cannot find the data mount of the backup container"
echo "    data volume  $DATA_SRC (via image $IMAGE)"

if [ "$DRY" = 0 ] && [ "$YES" = 0 ]; then
  echo
  echo "This REPLACES the current database and data volume with backup $ID."
  read -r -p "Type the set id to continue: " a
  [ "$a" = "$ID" ] || die "aborted"
fi

# 4. safety backup of the current state ---------------------------------------------------------
if [ "$PRE" = 1 ]; then
  say "taking a safety backup of the current state (kind=pre-restore)"
  run "${DC[@]}" exec -T backup bash /scripts/backup-run.sh --kind pre-restore --no-remote --no-restore-test --no-prune ||
    die "safety backup failed - not restoring (use --skip-pre-backup to override)"
fi

# 5. database -------------------------------------------------------------------------------------
say "restoring the database"
run helper db "$ID"

# 6. files: extract next to the old contents, then swap, so a broken archive never empties /data
say "restoring the data volume"
SWAP='set -euo pipefail
new=/data/.restore-new; old=/data/.restore-old
trap "rm -rf $new" ERR
rm -rf "$new" "$old"; mkdir "$new"
tar -xzf - -C "$new"
mkdir "$old"
find /data -mindepth 1 -maxdepth 1 ! -name .restore-new ! -name .restore-old -exec mv -t "$old" {} +
find "$new" -mindepth 1 -maxdepth 1 -exec mv -t /data {} +
rmdir "$new"; rm -rf "$old"
find /data -mindepth 1 | wc -l'
if [ "$DRY" = 1 ]; then
  echo "    [dry-run] helper cat-data $ID | docker run --rm -i -v $DATA_SRC:/data $IMAGE (extract + swap)"
else
  GOT=$(helper cat-data "$ID" | docker run --rm -i -v "$DATA_SRC":/data --entrypoint bash "$IMAGE" -c "$SWAP")
  WANT=$(mget data.entries)
  # the archive listing contains "./" itself
  if [ "$((GOT + 1))" = "$WANT" ]; then echo "    data ok: $GOT entries restored"
  else die "data volume has $GOT entries, archive listed $WANT (including ./)"; fi
fi

# 7. done -------------------------------------------------------------------------------------------
if [ "$DRY" = 1 ]; then
  say "dry run complete - nothing was changed"
  exit 0
fi
if [ "$STOP_APP" = 1 ]; then
  say "starting the app (it applies any newer migrations on boot)"
  "${DC[@]}" start app
else
  say "restore complete. Start the app with: ${DC[*]} start app"
fi
