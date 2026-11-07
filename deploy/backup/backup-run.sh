#!/usr/bin/env bash
# One backup run: DB dump + data archive -> verified, immutable backup set.
#
#   backup-run.sh [--kind scheduled|manual|pre-restore] [--restore-test] [--no-restore-test]
#                 [--no-prune] [--no-remote]
#
# Set layout ($BACKUP_ROOT/sets/<YYYYMMDD-HHMMSS UTC>/):
#   db.dump[.enc]       pg_dump -Fc, taken inside one REPEATABLE READ snapshot
#   data.tar.gz[.enc]   tar of the app data volume (uploads/, plugins/ ...)
#   manifest.json       times, sizes, sha256, app version, migration state, row counts
#   SHA256SUMS          `sha256sum -c` compatible
#
# The set is assembled in sets/.tmp-<id> and renamed into place only after every step and
# verification succeeded, so an incomplete set is never visible and is removed on failure.
# Exit codes: 0 ok, 1 failed, 75 another backup/restore holds the lock.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

KIND=manual
FORCE_RESTORE_TEST=0
SKIP_RESTORE_TEST=0
DO_PRUNE=1
DO_REMOTE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --kind) KIND="$2"; shift 2 ;;
    --restore-test) FORCE_RESTORE_TEST=1; shift ;;
    --no-restore-test) SKIP_RESTORE_TEST=1; shift ;;
    --no-prune) DO_PRUNE=0; shift ;;
    --no-remote) DO_REMOTE=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$KIND" in scheduled|manual|pre-restore) ;; *) echo "bad --kind" >&2; exit 2 ;; esac

mkdir -p "$SETS_DIR" "$CTL_DIR" 2>/dev/null || mkdir -p "$SETS_DIR"

# --- lock --------------------------------------------------------------------------------
# flock is released by the kernel when the holder dies, so a crashed run can never leave a
# stale lock behind. The lock file content is informational only.
exec 9>>"$LOCK_FILE"
if ! flock -n 9; then
  log "another backup or restore is running (lock held: $(cat "$LOCK_FILE" 2>/dev/null | tr '\n' ' '))"
  exit 75
fi
: >"$LOCK_FILE"; printf 'pid=%s kind=%s started=%s host=%s\n' "$$" "$KIND" "$(now_iso)" "$(hostname)" >>"$LOCK_FILE"

ID=$(date -u +%Y%m%d-%H%M%S)
TMP="$SETS_DIR/.tmp-$ID"
STARTED=$(now_iso)
START_S=$(date +%s)
PSQL_PID=""

fail() {
  local msg="$1"
  log "FAILED: $msg"
  [ -n "$PSQL_PID" ] && kill "$PSQL_PID" 2>/dev/null || true
  rm -rf "$TMP"
  status_set "running:=null" \
    "lastFailure.at=$(now_iso)" "lastFailure.kind=$KIND" "lastFailure.setId=$ID" \
    "lastFailure.message:=$(jstr "$msg")"
  exit 1
}
trap 'fail "unexpected error at line $LINENO (exit $?)"' ERR
trap 'fail "interrupted"' INT TERM

status_set "running:=$(json obj kind="$KIND" startedAt="$STARTED" setId="$ID" "pid:=$$")"
status_config
log "start kind=$KIND id=$ID encrypted=$(is_encrypted && echo yes || echo no)"

# Leftovers of crashed runs (we hold the lock, so nothing else is writing them).
find "$SETS_DIR" -mindepth 1 -maxdepth 1 -type d -name '.tmp-*' -exec rm -rf {} + 2>/dev/null || true

# --- 0. retention before the space check ------------------------------------------------------
# Without this a full backup volume deadlocks: the space check fails, so the post-run prune
# below never runs, so space is never freed. gfs_prune_list always keeps the newest valid set.
# The post-success prune (step 4) still runs, so retention results are unchanged.
prune_sets() {
  local old
  for old in $(list_sets | gfs_prune_list); do
    log "prune local set $old"
    rm -rf "${SETS_DIR:?}/$old"
  done
  # sets without a manifest that are not ours (e.g. hand-copied, half-deleted) are left alone
}
if [ "$DO_PRUNE" = 1 ]; then prune_sets; fi

# --- disk space ----------------------------------------------------------------------------
# Upper bound of what this run writes: DB size on disk (compressed dump is smaller) + data
# volume size (gzip only shrinks it) + a safety margin.
DB_BYTES=$(psql -X -At -v ON_ERROR_STOP=1 -c "select pg_database_size(current_database())") \
  || fail "cannot connect to the database (PGHOST=${PGHOST:-?})"
DATA_BYTES=$(du -sb "$DATA_DIR" 2>/dev/null | cut -f1 || echo 0)
NEED=$((DB_BYTES + DATA_BYTES + BACKUP_MIN_FREE_MB * 1024 * 1024))
FREE=$(( $(df -Pk "$BACKUP_ROOT" | awk 'NR==2 {print $4}') * 1024 ))
if [ "$FREE" -lt "$NEED" ]; then
  fail "not enough free disk space on the backup volume: need ~$((NEED / 1048576)) MiB, have $((FREE / 1048576)) MiB"
fi
mkdir -p "$TMP"

# --- 1. database: one exported snapshot for row counts + pg_dump -----------------------------
# A long-lived psql session exports a REPEATABLE READ snapshot; row counts are taken in that
# session and pg_dump --snapshot reads exactly the same data. The manifest's row counts are
# therefore the dump's row counts, which the restore test compares against.
coproc PSQL { psql -X -q -At -v ON_ERROR_STOP=1 2>&1; }
PSQL_PID=$PSQL_PID
psql_send() { printf '%s\n' "$1" >&"${PSQL[1]}"; }
psql_read_until() { # read lines until the marker line into $OUT (coproc fds are not
  local line             # usable inside $(...) subshells, so no command substitution here)
  OUT=""
  while IFS= read -r -t 600 -u "${PSQL[0]}" line; do
    [ "$line" = "$1" ] && return 0
    OUT+="$line"$'\n'
  done
  return 1
}
psql_send "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;"
psql_send "SELECT pg_export_snapshot();"
psql_send "SELECT '__SNAP__';"
psql_read_until "__SNAP__" || fail "could not export a snapshot: $OUT"
SNAP=$(printf '%s' "$OUT" | grep -v '^$' | tail -n1)
[[ "$SNAP" =~ ^[0-9A-F-]+$ ]] || fail "unexpected snapshot id: $SNAP"
SNAP_AT=$(now_iso)

psql_send "SELECT format('SELECT %L || ''|'' || count(*) FROM %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  ORDER BY 1 \gexec"
psql_send "SELECT '__COUNTS__';"
psql_read_until "__COUNTS__" || fail "row count query failed: $OUT"
COUNTS="$OUT"
# guarded with \if: an error would end the session (ON_ERROR_STOP) and with it the snapshot
psql_send "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS has_mig \\gset"
psql_send "\\if :has_mig"
psql_send "SELECT count(*) || '|' || coalesce(max(created_at)::text, '') FROM drizzle.__drizzle_migrations;"
psql_send "\\else"
psql_send "SELECT '0|';"
psql_send "\\endif"
psql_send "SELECT current_setting('server_version');"
psql_send "SELECT '__MIG__';"
MIG=""
psql_read_until "__MIG__" && MIG="$OUT"
MIG_COUNT=$(printf '%s\n' "$MIG" | sed -n 1p | cut -d'|' -f1)
MIG_LAST=$(printf '%s\n' "$MIG" | sed -n 1p | cut -d'|' -f2)
PG_VERSION=$(printf '%s\n' "$MIG" | sed -n 2p)
[[ "$MIG_COUNT" =~ ^[0-9]+$ ]] || MIG_COUNT=0

COUNTS_JSON=$(printf '%s\n' "$COUNTS" | perl -MJSON::PP -ne 'chomp; next unless /^(.+)\|(\d+)$/; $h{$1}=0+$2; END { print JSON::PP->new->canonical->encode(\%h || {}) }')

DB_FILE=db.dump
is_encrypted && DB_FILE=db.dump.enc
log "pg_dump (snapshot $SNAP) -> $DB_FILE"
if is_encrypted; then
  pg_dump -Fc --snapshot="$SNAP" | enc_filter >"$TMP/$DB_FILE" || fail "pg_dump failed"
else
  pg_dump -Fc --snapshot="$SNAP" -f "$TMP/$DB_FILE" || fail "pg_dump failed"
fi
psql_send "COMMIT;"
psql_send "\\q"
exec {PSQL[1]}>&-
wait "$PSQL_PID" 2>/dev/null || true
PSQL_PID=""
DB_DONE_AT=$(now_iso)

# --- 2. files: tar of the data volume ------------------------------------------------------------
# Taken AFTER the DB snapshot: a file uploaded in between is merely an extra (unreferenced)
# file; a file hard-deleted in between (trash purge) leaves a DB row without its file.
DATA_FILE=data.tar.gz
is_encrypted && DATA_FILE=data.tar.gz.enc
FILES_START=$(now_iso)
log "tar $DATA_DIR -> $DATA_FILE"
trap - ERR # tar exit 1 is only a warning; handled below
set +e
if is_encrypted; then
  tar --warning=no-file-changed --warning=no-file-removed --exclude=./.restore-new --exclude=./.restore-old -C "$DATA_DIR" -czf - . | enc_filter >"$TMP/$DATA_FILE"
  rcs=("${PIPESTATUS[@]}")
else
  tar --warning=no-file-changed --warning=no-file-removed --exclude=./.restore-new --exclude=./.restore-old -C "$DATA_DIR" -czf "$TMP/$DATA_FILE" .
  rcs=("$?")
fi
set -e
trap 'fail "unexpected error at line $LINENO (exit $?)"' ERR
# GNU tar: 1 = some files changed while being read (live directory) -> warning, 2 = fatal
[ "${rcs[0]}" -le 1 ] || fail "tar failed (exit ${rcs[0]})"
[ "${rcs[1]:-0}" -eq 0 ] || fail "encryption of the data archive failed"
FILES_DONE_AT=$(now_iso)

# --- 3. verification of the stored artifacts ----------------------------------------------
log "verify: pg_restore --list + archive listing"
TOC=$(pg_toc "$TMP/$DB_FILE") || fail "pg_restore --list failed: dump unreadable"
TOC_ENTRIES=$(grep -cv "^;" <<<"$TOC" || true)
[ "$TOC_ENTRIES" -gt 0 ] || fail "pg_restore --list returned no entries"
DATA_ENTRIES=$(cat_plain "$TMP/$DATA_FILE" | tar -tzf - | wc -l) || fail "data archive unreadable"

cd "$TMP"
sha256sum "$DB_FILE" "$DATA_FILE" >SHA256SUMS
DB_SHA=$(sha256sum "$DB_FILE" | cut -d' ' -f1)
DATA_SHA=$(sha256sum "$DATA_FILE" | cut -d' ' -f1)
DB_SIZE=$(stat -c %s "$DB_FILE")
DATA_SIZE=$(stat -c %s "$DATA_FILE")
cd - >/dev/null

APP_VERSION=$(json get "$APP_INFO_FILE" appVersion 2>/dev/null || echo unknown)
APP_MIGRATION=$(json get "$APP_INFO_FILE" migration 2>/dev/null || echo unknown)
APP_MIG_COUNT=$(json get "$APP_INFO_FILE" migrationsCount 2>/dev/null || echo null)
[[ "$APP_MIG_COUNT" =~ ^[0-9]+$ ]] || APP_MIG_COUNT=null

GAP=$(( $(date -d "$FILES_DONE_AT" +%s) - $(date -d "$SNAP_AT" +%s) ))
FINISHED=$(now_iso)
json set "$TMP/manifest.json" \
  "format:=1" "id=$ID" "kind=$KIND" "createdAt=$STARTED" "finishedAt=$FINISHED" \
  "app.version=$APP_VERSION" "app.migration=$APP_MIGRATION" "app.migrationsCount:=$APP_MIG_COUNT" \
  "db.migrationsApplied:=$MIG_COUNT" "db.lastMigrationAt=$MIG_LAST" "db.serverVersion=$PG_VERSION" \
  "db.rowCounts:=$COUNTS_JSON" "db.tocEntries:=$TOC_ENTRIES" \
  "data.entries:=$DATA_ENTRIES" \
  "consistency.dbSnapshotAt=$SNAP_AT" "consistency.dbDumpDoneAt=$DB_DONE_AT" \
  "consistency.filesStartedAt=$FILES_START" "consistency.filesDoneAt=$FILES_DONE_AT" \
  "consistency.gapSeconds:=$GAP" \
  "encrypted:=$(is_encrypted && echo true || echo false)" \
  "cipher=$(is_encrypted && echo "$BACKUP_CIPHER_LABEL" || echo none)" \
  "files:=[{\"name\":\"$DB_FILE\",\"bytes\":$DB_SIZE,\"sha256\":\"$DB_SHA\"},{\"name\":\"$DATA_FILE\",\"bytes\":$DATA_SIZE,\"sha256\":\"$DATA_SHA\"}]" \
  "totalBytes:=$((DB_SIZE + DATA_SIZE))"
# re-check the checksums we just recorded (catches a short write on a full disk)
(cd "$TMP" && sha256sum -c --quiet SHA256SUMS) || fail "sha256 verification failed"

mv "$TMP" "$SETS_DIR/$ID"
DUR=$(( $(date +%s) - START_S ))
log "ok set=$ID size=$((DB_SIZE + DATA_SIZE)) bytes toc=$TOC_ENTRIES files=$DATA_ENTRIES gap=${GAP}s in ${DUR}s"
status_set "running:=null" \
  "lastSuccess.at=$FINISHED" "lastSuccess.setId=$ID" "lastSuccess.kind=$KIND" \
  "lastSuccess.sizeBytes:=$((DB_SIZE + DATA_SIZE))" "lastSuccess.durationSec:=$DUR" \
  "lastVerify.at=$FINISHED" "lastVerify.setId=$ID" "lastVerify.ok:=true" \
  "lastVerify.message:=$(jstr "pg_restore --list: $TOC_ENTRIES entries; archive: $DATA_ENTRIES entries; sha256 ok")"
trap - ERR INT TERM

# --- 4. retention (GFS) ----------------------------------------------------------------------
if [ "$DO_PRUNE" = 1 ]; then prune_sets; fi
status_set "setCount:=$(list_sets | wc -l)"

# --- 5. restore test (weekly by default) -------------------------------------------------------
if [ "$SKIP_RESTORE_TEST" = 0 ] && [ "$KIND" != pre-restore ]; then
  due=0
  if [ "$FORCE_RESTORE_TEST" = 1 ]; then due=1
  elif [ "$BACKUP_RESTORE_TEST_DAYS" -gt 0 ]; then
    last=$(json get "$STATUS_FILE" lastRestoreTest.at 2>/dev/null || echo "")
    if [ -z "$last" ] || [ $(( $(date +%s) - $(date -d "$last" +%s) )) -ge $(( BACKUP_RESTORE_TEST_DAYS * 86400 - 3600 )) ]; then
      due=1
    fi
  fi
  if [ "$due" = 1 ]; then
    BACKUP_LOCK_HELD=1 bash "$SCRIPTS_DIR/restore-test.sh" "$ID" || true # it records its own status
  fi
fi

# --- 6. remote copy ----------------------------------------------------------------------------
if [ "$DO_REMOTE" = 1 ] && [ -n "$BACKUP_RCLONE_REMOTE" ]; then
  bash "$SCRIPTS_DIR/remote-sync.sh" "$ID" || true # records remote.* and lastFailure itself
fi
exit 0
