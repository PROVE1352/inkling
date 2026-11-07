#!/usr/bin/env bash
# In-container half of deploy/restore.sh (runs inside the backup sidecar, which has the
# Postgres client tools, the passphrase and the backup volume).
#
#   restore-helper.sh verify   <set>   sha256 + decrypt + pg_restore --list + archive listing
#   restore-helper.sh manifest <set>   print manifest.json
#   restore-helper.sh db       <set>   DROP + CREATE the app database, pg_restore, compare row counts
#   restore-helper.sh cat-data <set>   write the plaintext data archive (tar.gz) to stdout
#   restore-helper.sh latest           print the newest set id
set -euo pipefail
source "$(dirname "$0")/lib.sh"

CMD="${1:-}"
ID="${2:-}"
if [ "$CMD" = latest ]; then list_sets | sed -n 1p; exit 0; fi
valid_set_id "$ID" || { echo "invalid set id: '$ID' (expected YYYYMMDD-HHMMSS)" >&2; exit 2; }
DIR="$SETS_DIR/$ID"
[ -f "$DIR/manifest.json" ] || { echo "backup set $ID not found (or incomplete) in $SETS_DIR" >&2; exit 1; }
file_n() { json get "$DIR/manifest.json" files | perl -MJSON::PP -e "my \$f=decode_json(join '',<STDIN>); print \$f->[$1]{name}"; }
DB_FILE=$(file_n 0)
DATA_FILE=$(file_n 1)

case "$CMD" in
  manifest) cat "$DIR/manifest.json" ;;

  verify)
    (cd "$DIR" && sha256sum -c SHA256SUMS) >&2
    if [ "$(json get "$DIR/manifest.json" encrypted)" = true ] && ! is_encrypted; then
      echo "set is encrypted but BACKUP_PASSPHRASE is not set in the backup service" >&2; exit 3
    fi
    n=$(pg_toc "$DIR/$DB_FILE" | grep -cv '^;' || true)
    [ "$n" -gt 0 ] || { echo "pg_restore --list: no entries (wrong passphrase or corrupt dump)" >&2; exit 1; }
    e=$(cat_plain "$DIR/$DATA_FILE" | tar -tzf - | wc -l)
    echo "verify ok: $DB_FILE ($n TOC entries), $DATA_FILE ($e archive entries)" >&2
    ;;

  cat-data) cat_plain "$DIR/$DATA_FILE" ;;

  db)
    exec 9>>"$LOCK_FILE"
    flock -n 9 || { echo "another backup or restore is running - try again in a minute" >&2; exit 75; }
    : >"$LOCK_FILE"; echo "pid=$$ kind=restore set=$ID started=$(now_iso)" >>"$LOCK_FILE"
    TARGET="${PGDATABASE:?PGDATABASE not set}"
    OWNER="${PGUSER:?PGUSER not set}"
    log "restore: dropping and recreating database $TARGET"
    psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE IF EXISTS \"$TARGET\" WITH (FORCE)" \
      -c "CREATE DATABASE \"$TARGET\" OWNER \"$OWNER\""
    log "restore: pg_restore $DB_FILE -> $TARGET"
    cat_plain "$DIR/$DB_FILE" | pg_restore --no-owner --exit-on-error -d "$TARGET"
    bad=""; n=0
    while IFS='|' read -r tbl want; do
      [ -n "$tbl" ] || continue
      schema=${tbl%%.*}; rel=${tbl#*.}
      got=$(psql -X -At -d "$TARGET" -c "SELECT count(*) FROM \"$schema\".\"$rel\"" 2>/dev/null || echo missing)
      n=$((n + 1))
      [ "$got" = "$want" ] || bad="$bad $tbl(expected $want, got $got)"
    done < <(json get "$DIR/manifest.json" db.rowCounts | perl -MJSON::PP -e 'my $h=decode_json(join "",<STDIN>); print "$_|$h->{$_}\n" for sort keys %$h')
    if [ -n "$bad" ]; then echo "restore: ROW COUNT MISMATCH:$bad" >&2; exit 1; fi
    echo "restore: database ok - $n tables, row counts match the manifest" >&2
    status_set "lastRestore.at=$(now_iso)" "lastRestore.setId=$ID"
    ;;

  *) echo "usage: restore-helper.sh verify|manifest|db|cat-data <set> | latest" >&2; exit 2 ;;
esac
