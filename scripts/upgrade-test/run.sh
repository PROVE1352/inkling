#!/usr/bin/env bash
# Upgrade-path test (docs/adr/1052-*): an old release's image creates and fills a database, then
# the new image boots on the same database and volume, migrates it in its boot transaction
# (apps/server/src/db/index.ts runMigrations), and must return the same data.
#
#   scripts/upgrade-test/run.sh OLD_IMAGE NEW_IMAGE
#
# Both images must already exist locally (CI builds them with docker/build-push-action; locally:
# `git archive <ref> | docker build -t inkling-upg:<name> -`, see CONTRIBUTING.md "Running CI
# locally"). Everything this script creates is named inkling-upg-<random> and removed on exit
# (KEEP=1 keeps it for debugging). It never touches the compose project (`nodian`).
#
# Steps:
#   1. postgres:16 on a private network (same major as compose.yaml)
#   2. OLD_IMAGE boots (its own migrations), seed-verify.mjs seed writes data through its API
#   3. OLD stops with SIGTERM (it flushes collaborative documents), table row counts recorded
#   4. NEW_IMAGE boots on the same database + /data volume, migrations run at boot
#   5. /api/health and /api/health/ready, migration journal = every file in NEW's drizzle/,
#      row counts unchanged, seed-verify.mjs verify compares the data through the new API
set -euo pipefail

OLD_IMAGE=${1:?usage: run.sh OLD_IMAGE NEW_IMAGE}
NEW_IMAGE=${2:?usage: run.sh OLD_IMAGE NEW_IMAGE}
PG_IMAGE=${PG_IMAGE:-postgres:16}
HERE=$(cd "$(dirname "$0")" && pwd)
ID=inkling-upg-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8 || true)
NET=$ID-net
PG=$ID-db
APP=$ID-app
VOL=$ID-data
WORK=$(mktemp -d "${TMPDIR:-/tmp}/$ID.XXXX")
FP=$WORK/fingerprint.json

log() { printf '[upgrade-test] %s\n' "$*"; }
fail() { log "FAIL: $*"; exit 1; }

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && docker inspect "$APP" >/dev/null 2>&1; then
    log "app log (last 80 lines):"
    docker logs --tail 80 "$APP" 2>&1 | sed 's/^/    /' || true
  fi
  if [ "${KEEP:-0}" = 1 ]; then
    log "KEEP=1: leaving $PG, $APP, $NET, $VOL and $WORK"
    return
  fi
  docker rm -f "$APP" "$PG" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

psql_q() { docker exec "$PG" psql -U inkling -d inkling -AtX -v ON_ERROR_STOP=1 -c "$1"; }

# Row count of every table in the public schema, "table count" per line, sorted.
table_counts() {
  local tables t
  tables=$(psql_q "select tablename from pg_tables where schemaname = 'public' order by 1")
  for t in $tables; do
    printf '%s %s\n' "$t" "$(psql_q "select count(*) from \"$t\"")"
  done
}

# Start an app container from $1 and wait until /api/health answers; prints the base URL.
start_app() {
  local image=$1 port i
  docker run -d --name "$APP" --network "$NET" \
    -e DATABASE_URL=postgres://inkling:inkling@db:5432/inkling \
    -e SIGNUP_REQUIRE_KEY=0 -e COOKIE_SECURE=0 -e TZ=UTC \
    -v "$VOL:/data" -p 127.0.0.1::3000 "$image" >/dev/null
  port=$(docker port "$APP" 3000/tcp | head -1 | sed 's/.*://')
  for i in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
      echo "http://127.0.0.1:$port"
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$APP")" != true ]; then
      log "$image exited during boot" >&2
      return 1
    fi
    sleep 2
  done
  log "$image did not answer /api/health within 180 s" >&2
  return 1
}

stop_app() {
  # SIGTERM with time to flush open documents (compose uses stop_grace_period: 30s).
  docker stop -t 40 "$APP" >/dev/null
  docker rm "$APP" >/dev/null
}

log "old: $OLD_IMAGE"
log "new: $NEW_IMAGE"
docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null
docker run -d --name "$PG" --network "$NET" --network-alias db \
  -e POSTGRES_USER=inkling -e POSTGRES_PASSWORD=inkling -e POSTGRES_DB=inkling \
  "$PG_IMAGE" >/dev/null
for i in $(seq 1 60); do
  docker exec "$PG" pg_isready -U inkling -d inkling >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "postgres did not become ready"
  sleep 1
done
# pg_isready can answer during the image's init restart; wait for a real query.
for i in $(seq 1 30); do psql_q 'select 1' >/dev/null 2>&1 && break; sleep 1; done

# --- 1. old release ------------------------------------------------------------------------------
BASE=$(start_app "$OLD_IMAGE") || fail "old image did not start"
OLD_MIGRATIONS=$(psql_q 'select count(*) from drizzle.__drizzle_migrations')
log "old release up at $BASE, $OLD_MIGRATIONS migrations applied"
node "$HERE/seed-verify.mjs" seed --base "$BASE" --out "$FP"
stop_app
DOCS=$(psql_q "select count(*) from page_docs d join pages p on p.id = d.page_id where p.title in ('Upgrade doc', 'Nested child')")
[ "$DOCS" = 2 ] || fail "page_docs has $DOCS of 2 seeded documents after the old release stopped"
table_counts >"$WORK/counts.before"
# catch_up markers the old release kept in plugin_storage (moved to catch_up_markers by 0041)
MARKERS_BEFORE=$(psql_q "select count(*) from plugin_storage where plugin_id = 'inkling:catch_up'")
log "old release stopped; $(wc -l <"$WORK/counts.before" | tr -d ' ') tables recorded"

# --- 2. new release ------------------------------------------------------------------------------
BASE=$(start_app "$NEW_IMAGE") || fail "new image did not start (migration failure?)"
EXPECTED=$(docker run --rm --entrypoint sh "$NEW_IMAGE" -c 'ls /app/drizzle/*.sql | wc -l' | tr -d ' ')
NEW_MIGRATIONS=$(psql_q 'select count(*) from drizzle.__drizzle_migrations')
log "new release up at $BASE, migrations $OLD_MIGRATIONS -> $NEW_MIGRATIONS (image ships $EXPECTED)"
[ "$NEW_MIGRATIONS" = "$EXPECTED" ] || fail "journal has $NEW_MIGRATIONS migrations, image ships $EXPECTED"

READY=$(curl -fsS "$BASE/api/health/ready") || fail "/api/health/ready is not 200"
log "health/ready: $READY"

table_counts >"$WORK/counts.after"
# Every table that existed before must still exist with the same number of rows. Tables the new
# release adds are listed for the log only. A table that may legitimately change on boot would be
# allow-listed here with a reason:
# - workspace_acl_versions may only grow: rows are created lazily by writes and the boot
#   reconcile (reconcileAclVersions, docs/adr/1071-*) adds one for every workspace without one,
#   e.g. a workspace created after the old release booted. It is derived state, rebuilt at boot.
# - plugin_storage may shrink by exactly its reserved 'inkling:catch_up' rows: migration 0041 moves
#   them to catch_up_markers (docs/adr/1537-*). No plugin row may change.
changed=0
while read -r t n; do
  m=$(awk -v t="$t" '$1 == t { print $2 }' "$WORK/counts.after")
  if [ -z "$m" ]; then
    log "table $t ($n rows) is gone"
    changed=1
  elif [ "$t" = plugin_storage ] && [ "$m" = "$((n - MARKERS_BEFORE))" ]; then
    [ "$m" != "$n" ] && log "table $t: $n rows -> $m (allowed: $MARKERS_BEFORE catch_up markers moved)"
  elif [ "$t" = workspace_acl_versions ] && [ "$m" -ge "$n" ]; then
    [ "$m" != "$n" ] && log "table $t: $n rows -> $m (allowed: boot reconcile fills missing rows)"
  elif [ "$m" != "$n" ]; then
    log "table $t: $n rows -> $m"
    changed=1
  fi
done <"$WORK/counts.before"
added=$(awk 'NR == FNR { seen[$1] = 1; next } !seen[$1] { printf "%s ", $1 }' "$WORK/counts.before" "$WORK/counts.after")
[ -n "$added" ] && log "tables added by the new release: $added"
[ "$changed" = 0 ] || fail "row counts changed across the upgrade"
log "row counts unchanged in $(wc -l <"$WORK/counts.before" | tr -d ' ') tables"

node "$HERE/seed-verify.mjs" verify --base "$BASE" --in "$FP"

# The new release must also shut down cleanly on the migrated database.
stop_app
log "PASS: $OLD_IMAGE -> $NEW_IMAGE"
