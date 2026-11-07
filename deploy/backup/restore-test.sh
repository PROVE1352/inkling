#!/usr/bin/env bash
# Restore test: load a backup set into a throw-away database on the same Postgres server and
# compare every table's row count with the counts recorded at dump time (same snapshot).
# Also lists the data archive and compares its entry count.
#
#   restore-test.sh [<set-id>]      default: newest set
#
# Records status.json lastRestoreTest (and lastFailure when it fails). Exit 0 ok, 1 failed.
# Note: this temporarily needs roughly the DB's size again on the database server's disk.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

ID="${1:-$(list_sets | sed -n 1p)}"
[ -n "$ID" ] || { log "restore-test: no backup set found"; exit 1; }
valid_set_id "$ID" || { log "restore-test: bad set id"; exit 2; }
DIR="$SETS_DIR/$ID"
[ -f "$DIR/manifest.json" ] || { log "restore-test: $ID has no manifest"; exit 1; }

if [ "${BACKUP_LOCK_HELD:-0}" != 1 ]; then
  exec 9>>"$LOCK_FILE"
  flock -n 9 || { log "restore-test: another backup or restore is running"; exit 75; }
fi

DB="$RESTORE_TEST_DB"
admin_psql() { psql -X -q -At -v ON_ERROR_STOP=1 -d postgres "$@"; }
cleanup() { admin_psql -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1 || true; }

record_fail() {
  local msg="$1"
  log "restore-test FAILED ($ID): $msg"
  cleanup
  status_set "lastRestoreTest.at=$(now_iso)" "lastRestoreTest.setId=$ID" "lastRestoreTest.ok:=false" \
    "lastRestoreTest.message:=$(jstr "$msg")" \
    "lastFailure.at=$(now_iso)" "lastFailure.kind=restore-test" "lastFailure.setId=$ID" \
    "lastFailure.message:=$(jstr "restore test failed: $msg")"
  exit 1
}

DB_FILE=$(json get "$DIR/manifest.json" files | perl -MJSON::PP -e 'my $f=decode_json(join "",<STDIN>); print $f->[0]{name}')
DATA_FILE=$(json get "$DIR/manifest.json" files | perl -MJSON::PP -e 'my $f=decode_json(join "",<STDIN>); print $f->[1]{name}')
case "$DB_FILE" in db.dump|db.dump.enc) ;; *) record_fail "unexpected file name in manifest" ;; esac

log "restore-test $ID -> database $DB"
START_S=$(date +%s)
(cd "$DIR" && sha256sum -c --quiet SHA256SUMS) || record_fail "sha256 mismatch"

cleanup
admin_psql -c "CREATE DATABASE \"$DB\"" >/dev/null || record_fail "cannot create database $DB"
# stdin restore (custom format, sequential). --no-owner/--no-privileges: the test only checks data.
ERR_LOG=$(mktemp)
if ! cat_plain "$DIR/$DB_FILE" | pg_restore --no-owner --no-privileges --exit-on-error -d "$DB" 2>"$ERR_LOG"; then
  msg=$(tail -n 3 "$ERR_LOG" | tr '\n' ' ')
  rm -f "$ERR_LOG"
  record_fail "pg_restore failed: ${msg:-unknown error}"
fi
rm -f "$ERR_LOG"

# Compare every table counted at dump time.
EXPECTED=$(json get "$DIR/manifest.json" db.rowCounts)
MISMATCH=""
CHECKED=0
TOTAL_ROWS=0
while IFS='|' read -r tbl want; do
  [ -n "$tbl" ] || continue
  schema=${tbl%%.*}; rel=${tbl#*.}
  got=$(psql -X -At -d "$DB" -c "SELECT count(*) FROM \"$schema\".\"$rel\"" 2>/dev/null || echo "missing")
  CHECKED=$((CHECKED + 1))
  if [ "$got" != "$want" ]; then MISMATCH="$MISMATCH $tbl(expected $want, got $got)"; fi
  [[ "$got" =~ ^[0-9]+$ ]] && TOTAL_ROWS=$((TOTAL_ROWS + got))
done < <(printf '%s' "$EXPECTED" | perl -MJSON::PP -e 'my $h=decode_json(join "",<STDIN>); print "$_|$h->{$_}\n" for sort keys %$h')
[ "$CHECKED" -gt 0 ] || record_fail "manifest has no row counts"
[ -z "$MISMATCH" ] || record_fail "row count mismatch:$MISMATCH"

WANT_ENTRIES=$(json get "$DIR/manifest.json" data.entries)
GOT_ENTRIES=$(cat_plain "$DIR/$DATA_FILE" | tar -tzf - | wc -l) || record_fail "data archive unreadable"
[ "$GOT_ENTRIES" = "$WANT_ENTRIES" ] || record_fail "data archive has $GOT_ENTRIES entries, manifest says $WANT_ENTRIES"

cleanup
DUR=$(( $(date +%s) - START_S ))
MSG="restored into a temporary database: $CHECKED tables, $TOTAL_ROWS rows match; archive $GOT_ENTRIES entries match (${DUR}s)"
log "restore-test ok ($ID): $MSG"
status_set "lastRestoreTest.at=$(now_iso)" "lastRestoreTest.setId=$ID" "lastRestoreTest.ok:=true" \
  "lastRestoreTest.tables:=$CHECKED" "lastRestoreTest.rows:=$TOTAL_ROWS" \
  "lastRestoreTest.message:=$(jstr "$MSG")"
exit 0
