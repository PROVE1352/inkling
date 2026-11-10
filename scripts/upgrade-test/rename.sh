#!/usr/bin/env bash
# Rename test (docs/adr/2342-*): an install of an old release with the old data names (nodian), set up
# like a production server (a copied folder, compose.yaml + compose.override.yaml with a source-built
# image), upgraded to this tree, then moved to the new names with deploy/rename-from-nodian.sh.
#
#   scripts/upgrade-test/rename.sh OLD_TREE NEW_TREE OLD_IMAGE NEW_IMAGE
#
# OLD_TREE / NEW_TREE: source folders (the release's files; no .git needed). The images must exist.
# Every step prints PASS or FAIL; the first FAIL stops the run (exit 1).
#   1  the old release on the old names, data through its API: account, pages, comments, collection
#      rows (seed-verify.mjs), an attachment and a share link (rename-extra.mjs)
#   2  the new files and image without touching .env: compose refuses (all overlay combinations), the
#      old stack keeps running, no new-name volume appears
#   3  INKLING_DATA_NAME=<old> in .env: the new release runs on the old data
#   4  rename --dry-run changes nothing
#   5  rename: new names everywhere, same data, share link, attachment bytes, login, backup sidecar dump
#   6  rollback, and interrupted renames (after the copy, after the role rename) that are run again or
#      rolled back
#   7  a new install from .env.example: no old name in containers, volumes or roles; deploy/*.sh work
#
# Environment: FROM / TO (default nodian / inkling) are the old and new names (a machine that already
# runs a `nodian` project uses other ones; the old tree's files are rewritten to FROM). LOCAL_TAG (default
# inkling:local) is the tag the override names. APP_PORT (default 3130; step 7 uses the next one) and DB_PORT
# (default 55440, and the next one); a release before 0.17 uses 3000 and 55432 until it is upgraded.
# EXPECT_MIGRATIONS: "OLD NEW" rows of the migration journal before and after step 3 (e.g. "59 61" from
# 0.18.0); without it the new count only has to be at least the old one. FRESH_PROJECT: COMPOSE_PROJECT_NAME of the new install in step 7 (default none, so the project is
# `inkling`; that install keeps .env.example's INKLING_DATA_NAME). WORK: work folder (default a new
# temporary one). KEEP=1 leaves everything in place. Needs docker, node 18+, curl, perl, rsync.
set -euo pipefail
# (checks read a command's output with `grep <<<"$(cmd)"`, not `cmd | grep -q`: with pipefail, grep -q
# leaving early kills a chatty cmd with SIGPIPE and fails the check)

OLD_TREE=$(cd "${1:?usage: rename.sh OLD_TREE NEW_TREE OLD_IMAGE NEW_IMAGE}" && pwd)
NEW_TREE=$(cd "${2:?usage}" && pwd)
OLD_IMAGE=${3:?usage}
NEW_IMAGE=${4:?usage}
FROM=${FROM:-nodian}
TO=${TO:-inkling}
LOCAL_TAG=${LOCAL_TAG:-inkling:local}
APP_PORT=${APP_PORT:-3130}
DB_PORT=${DB_PORT:-55440}
FRESH_PROJECT=${FRESH_PROJECT:-}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/rename-test.XXXX")}
INST=$WORK/install
FRESH=$WORK/fresh
FP=$WORK/fingerprint.json
EX=$WORK/extra.json
BASE=http://127.0.0.1:$APP_PORT
FBASE=http://127.0.0.1:$((APP_PORT + 1))
STEP=''

log() { printf '[rename-test] %s\n' "$*"; }
step() { STEP=$1; shift; log "--- $STEP: $*"; }
pass() { printf '[rename-test] PASS %s%s\n' "$STEP" "${1:+: $1}"; }
fail() { printf '[rename-test] FAIL %s: %s\n' "$STEP" "$*"; exit 1; }

P_OLD=$FROM
P_NEW=$TO
P_FRESH=${FRESH_PROJECT:-inkling}
in_inst() { (cd "$INST" && "$@"); }
in_fresh() { (cd "$FRESH" && "$@"); }
rename() { in_inst ./deploy/rename-from-nodian.sh --from "$FROM" --to "$TO" "$@"; }

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    for p in "$P_OLD" "$P_NEW"; do
      docker ps -a --filter "label=com.docker.compose.project=$p" --format '{{.Names}}' | while read -r c; do
        log "log of $c (last 30 lines):"; docker logs --tail 30 "$c" 2>&1 | sed 's/^/    /'
      done
    done
  fi
  if [ "${KEEP:-0}" = 1 ]; then log "KEEP=1: leaving $WORK and the containers"; return; fi
  [ -d "$INST" ] && (cd "$INST" && INKLING_DATA_NAME=$FROM docker compose down -v --remove-orphans >/dev/null 2>&1 || true)
  [ -d "$INST" ] && (cd "$INST" && INKLING_DATA_NAME=$TO docker compose down -v --remove-orphans >/dev/null 2>&1 || true)
  [ -d "$FRESH" ] && (cd "$FRESH" && docker compose down -v --remove-orphans >/dev/null 2>&1 || true)
  docker rm -f "$P_NEW-rename-pg" >/dev/null 2>&1 || true
  for v in $(docker volume ls -q | grep -E "^($P_OLD|$P_NEW|$P_FRESH)_($FROM|$TO|inkling)-" || true); do docker volume rm "$v" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

wait_ready() { # URL
  local i
  for i in $(seq 1 120); do curl -fsS "$1/api/health/ready" >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}
names() { # every container, volume and network name of a project, plus its database roles
  docker ps -a --filter "label=com.docker.compose.project=$1" --format '{{.Names}}'
  docker volume ls -q | grep -E "^$1_" || true
  docker network ls --format '{{.Name}}' | grep -E "^$1_" || true
}
roles() { # database roles (without the built-in pg_*) and databases of the install in $1
  (cd "$1" && docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -AtX -c "select rolname from pg_roles union all select datname from pg_database"') | grep -v '^pg_'
}
verify_data() { # BASE: the same data as seeded
  node "$HERE/seed-verify.mjs" verify --base "$1" --in "$FP" >/dev/null || fail "seed-verify: data differs"
  node "$HERE/rename-extra.mjs" verify --base "$1" --fp "$FP" --in "$EX" || fail "attachment / share link / login"
}
migrations() { # rows of the migration journal of the install in $1
  (cd "$1" && docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -AtX -c "select count(*) from drizzle.__drizzle_migrations"') | tr -d '[:space:]'
}
volumes_of() { docker volume ls -q | grep -E "^$1_" | sort | tr '\n' ' '; }
env_line() { local tmp; tmp=$(mktemp); grep -v "^$2=" "$1" >"$tmp" || true; printf '%s=%s\n' "$2" "$3" >>"$tmp"; cat "$tmp" >"$1"; rm -f "$tmp"; }

log "old $OLD_IMAGE ($OLD_TREE), new $NEW_IMAGE ($NEW_TREE), names $FROM -> $TO, work $WORK"
for p in "$P_OLD" "$P_NEW" "$P_FRESH"; do
  [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$p")" ] || fail "compose project $p already exists on this machine; set FROM/TO/FRESH_PROJECT"
done

# ==================================================================================================
step 1 "v-old installed with the old names, data seeded"
mkdir -p "$INST"
rsync -a --exclude .git --exclude node_modules "$OLD_TREE/" "$INST/"
if [ "$FROM" != nodian ]; then # same files with another old name (this machine runs a real `nodian`)
  for f in compose.yaml compose.local.yaml deploy/*.sh deploy/compose.*.yaml; do
    [ -f "$INST/$f" ] && perl -pi -e "s/\\bnodian\\b/$FROM/g" "$INST/$f"
  done
fi
grep -q "^name: $FROM\$" "$INST/compose.yaml" || fail "the old compose.yaml has no 'name: $FROM'"
# Releases before 0.17 publish the app on 3000 (no INKLING_PORT); the new compose.yaml moves it to APP_PORT.
OLD_BASE=$BASE
grep -q INKLING_PORT "$INST/compose.yaml" || OLD_BASE=http://127.0.0.1:3000
docker tag "$OLD_IMAGE" "$LOCAL_TAG"
umask 077
cat >"$INST/.env" <<EOF
POSTGRES_PASSWORD=$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 32 || true)
INKLING_PORT=127.0.0.1:$APP_PORT
INKLING_DB_PORT=$DB_PORT
PUBLIC_URL=$BASE
SIGNUP_REQUIRE_KEY=0
BACKUP_SCHEDULE=off
TZ=UTC
EOF
umask 022
# production's override shape: the app runs a source build that compose never pulls
cat >"$INST/compose.override.yaml" <<EOF
services:
  app:
    image: $LOCAL_TAG
    pull_policy: never
EOF
in_inst docker compose up -d >/dev/null 2>&1 || in_inst docker compose up -d
wait_ready "$OLD_BASE" || fail "the old release did not become ready"
node "$HERE/seed-verify.mjs" seed --base "$OLD_BASE" --out "$FP"
node "$HERE/rename-extra.mjs" seed --base "$OLD_BASE" --fp "$FP" --out "$EX"
OLD_IDS=$(docker ps -q --filter "label=com.docker.compose.project=$P_OLD" | sort | tr '\n' ' ')
OLD_VOLS=$(volumes_of "$P_OLD")
MIG_OLD=$(migrations "$INST")
log "old stack: $(names "$P_OLD" | tr '\n' ' '); migrations $MIG_OLD"
pass "$OLD_VOLS"

# ==================================================================================================
step 2 "new files and image, nothing else changed"
rsync -a --delete --exclude .git --exclude node_modules --exclude .env --exclude compose.override.yaml \
  --exclude backups/ "$NEW_TREE/" "$INST/"
docker tag "$NEW_IMAGE" "$LOCAL_TAG" # what `docker compose up -d --build` leaves behind
for variant in "" "-f compose.yaml -f deploy/compose.caddy.yaml" \
  "-f compose.yaml -f compose.override.yaml -f deploy/compose.backup-rclone.yaml" "-p $P_OLD"; do
  # shellcheck disable=SC2086
  out=$(cd "$INST" && DOMAIN=example.com docker compose $variant up -d 2>&1) && fail "compose started with '$variant'"
  printf '%s' "$out" | grep -q 'INKLING_DATA_NAME' || fail "refusal without the INKLING_DATA_NAME message: $out"
done
out=$(cd "$INST" && COMPOSE_PROJECT_NAME=$P_OLD docker compose pull 2>&1) && fail "compose pull ran"
log "refusal: $(printf '%s' "$out" | tail -n 1)"
[ "$(docker ps -q --filter "label=com.docker.compose.project=$P_OLD" | sort | tr '\n' ' ')" = "$OLD_IDS" ] || fail "the old containers changed"
[ "$(volumes_of "$P_OLD")" = "$OLD_VOLS" ] || fail "volumes changed: $(volumes_of "$P_OLD")"
[ -z "$(docker volume ls -q | grep -E "_$TO-" | grep -E "^($P_OLD|$P_NEW)_" || true)" ] || fail "a new-name volume appeared"
verify_data "$OLD_BASE"
pass "compose refuses with the INKLING_DATA_NAME message; the old stack still serves the data"

# ==================================================================================================
step 3 "INKLING_DATA_NAME=$FROM in .env: the new release on the old data"
env_line "$INST/.env" INKLING_DATA_NAME "$FROM"
in_inst docker compose up -d >/dev/null 2>&1 || in_inst docker compose up -d
wait_ready "$BASE" || fail "the new release did not become ready on the old names"
[ "$(volumes_of "$P_OLD")" = "$OLD_VOLS" ] || fail "volumes changed: $(volumes_of "$P_OLD")"
verify_data "$BASE"
in_inst ./deploy/signup-key.sh list >/dev/null || fail "deploy/signup-key.sh on the old names"
MIG_NEW=$(migrations "$INST")
[ "$MIG_NEW" -ge "$MIG_OLD" ] || fail "migration journal shrank: $MIG_OLD -> $MIG_NEW"
[ -z "${EXPECT_MIGRATIONS:-}" ] || [ "$MIG_OLD $MIG_NEW" = "$EXPECT_MIGRATIONS" ] || fail "migrations $MIG_OLD -> $MIG_NEW, expected $EXPECT_MIGRATIONS"
pass "migrations $MIG_OLD -> $MIG_NEW; project $P_OLD, $(docker ps --filter "label=com.docker.compose.project=$P_OLD" --format '{{.Names}}' | sort | tr '\n' ' ')"

# ==================================================================================================
step 4 "rename --dry-run"
sum_env=$(cksum <"$INST/.env")
rename --dry-run >"$WORK/dry.log" 2>&1 || { cat "$WORK/dry.log"; fail "dry run failed"; }
sed 's/^/    /' "$WORK/dry.log"
[ "$(cksum <"$INST/.env")" = "$sum_env" ] || fail ".env changed"
[ "$(volumes_of "$P_OLD")" = "$OLD_VOLS" ] || fail "volumes changed"
[ -z "$(docker volume ls -q | grep -E "^${P_NEW}_$TO-" || true)" ] || fail "a new-name volume appeared"
grep -q 'expected downtime' "$WORK/dry.log" || fail "no downtime estimate"
wait_ready "$BASE" || fail "the app is not serving after the dry run"
pass "nothing changed"

forward() { # args for the script; checks the result
  rename --yes "$@" || fail "rename failed"
  wait_ready "$BASE" || fail "not ready after the rename"
  local n
  n=$(names "$P_NEW" | grep -c "$FROM" || true)
  [ "$P_NEW" = "$P_OLD" ] || [ "$n" = 0 ] || fail "old name in the new stack: $(names "$P_NEW" | tr '\n' ' ')"
  [ -z "$(docker ps -q --filter "label=com.docker.compose.project=$P_OLD")" ] || [ "$P_NEW" = "$P_OLD" ] || fail "old containers still exist"
  grep -qx "$FROM" <<<"$(roles "$INST")" && fail "role or database $FROM in the new stack"
  grep -qx "$TO" <<<"$(roles "$INST")" || fail "no role/database $TO"
  verify_data "$BASE"
  grep -qx "INKLING_DATA_NAME=$TO" "$INST/.env" || fail ".env not switched"
}
backward() {
  rename --rollback || fail "rollback failed"
  wait_ready "$BASE" || fail "not ready after the rollback"
  grep -qx "INKLING_DATA_NAME=$FROM" "$INST/.env" || fail ".env not switched back"
  [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$P_OLD")" ] || fail "the old stack is not running"
}

# ==================================================================================================
step 5 "rename"
forward
[ "$(migrations "$INST")" = "$MIG_NEW" ] || fail "migration journal changed by the rename: $(migrations "$INST")"
STATUS=$(in_inst docker compose exec -T backup cat /backups/status.json)
printf '%s' "$STATUS" | grep -q '"lastSuccess"' || fail "no backup recorded under the new names"
last=$(in_inst ./deploy/backup.sh list | head -n 1)
[ -n "$last" ] || fail "no backup sets"
in_inst ./deploy/backup.sh >/dev/null || fail "./deploy/backup.sh under the new names"
log "new stack: $(names "$P_NEW" | tr '\n' ' ')"
log "old volumes left in place: $(volumes_of "$P_OLD")"
pass "same data, share link 200, attachment bytes, login, backup sidecar dump with role $TO"

# ==================================================================================================
step 6a "rollback after a finished rename"
backward
verify_data "$BASE"
pass "old names serve the data"

step 6b "rename interrupted right after the volume copy, then run again"
INKLING_RENAME_TEST_KILL=after-copy rename --yes >/dev/null 2>&1 && fail "the test kill did not stop the run"
grep -qx stopped "$INST/backups/rename-$FROM-to-$TO/state" || fail "no state after the kill"
forward
pass "the second run finished"

step 6c "rollback, rename interrupted right after the role rename, then run again"
backward
INKLING_RENAME_TEST_KILL=after-role rename --yes >/dev/null 2>&1 && fail "the test kill did not stop the run"
docker ps -q --filter name="^$P_NEW-rename-pg\$" | grep -q . || log "(temporary server already gone)"
forward
pass "the second run finished (stale temporary server, renamed role, old database name)"

step 6d "rollback from an interrupted run (after the role rename)"
backward
INKLING_RENAME_TEST_KILL=after-role rename --yes >/dev/null 2>&1 && fail "the test kill did not stop the run"
backward
verify_data "$BASE"
pass "old names start and serve the data from any point"

step 6e "rename once more to finish on the new names"
forward
pass

# ==================================================================================================
step 7 "new install from .env.example"
# The renamed install goes first: with the default names both are project `inkling` (CI).
(cd "$INST" && docker compose down -v >/dev/null 2>&1 && INKLING_DATA_NAME=$FROM docker compose down -v >/dev/null 2>&1) ||
  fail "removing the renamed install"
mkdir -p "$FRESH"
rsync -a --exclude .git --exclude node_modules --exclude .env --exclude compose.override.yaml --exclude backups/ "$NEW_TREE/" "$FRESH/"
cp "$FRESH/.env.example" "$FRESH/.env"
env_line "$FRESH/.env" POSTGRES_PASSWORD "$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 32 || true)"
env_line "$FRESH/.env" INKLING_PORT "127.0.0.1:$((APP_PORT + 1))"
env_line "$FRESH/.env" INKLING_DB_PORT "$((DB_PORT + 1))"
env_line "$FRESH/.env" PUBLIC_URL "$FBASE"
env_line "$FRESH/.env" BACKUP_SCHEDULE off
[ -n "$FRESH_PROJECT" ] && env_line "$FRESH/.env" COMPOSE_PROJECT_NAME "$FRESH_PROJECT"
cp "$INST/compose.override.yaml" "$FRESH/"
in_fresh docker compose up -d >/dev/null 2>&1 || in_fresh docker compose up -d
wait_ready "$FBASE" || fail "the new install did not become ready"
all=$( { names "$P_FRESH"; roles "$FRESH"; } | sort -u)
log "containers, volumes, networks, roles, databases: $(printf '%s' "$all" | tr '\n' ' ')"
printf '%s\n' "$all" | grep -qi -e nodian -e "$FROM" && fail "an old name in the new install"
# deploy scripts on the new install
in_fresh ./deploy/signup-key.sh new "rename test" >"$WORK/key.log" || fail "signup-key.sh new"
key=$(sed -nE 's/.*Signup key : ([A-Z0-9-]+).*/\1/p' "$WORK/key.log")
grep -q "…${key: -4}" <<<"$(in_fresh ./deploy/signup-key.sh list)" || fail "signup-key.sh list (stored as a hash, shown by its last four)"
curl -fsS -H 'content-type: application/json' \
  -d "{\"email\":\"fresh@example.com\",\"name\":\"Fresh\",\"password\":\"fresh-password-1\",\"signupKey\":\"$key\"}" \
  "$FBASE/api/auth/register" >/dev/null || fail "register with the key from signup-key.sh"
in_fresh ./deploy/signup-key.sh revoke "$key" >/dev/null || fail "signup-key.sh revoke"
grep -q 'Temporary password' <<<"$(in_fresh ./deploy/reset-password.sh fresh@example.com)" || fail "reset-password.sh"
in_fresh ./deploy/cli-token.sh new fresh@example.com 1 test >"$WORK/tok.log" || fail "cli-token.sh new"
tok=$(sed -nE 's/.*"cookie": "inkling_sid=([^"]+)".*/\1/p' "$WORK/tok.log" | head -n 1)
grep -q fresh@example.com <<<"$(curl -fsS -H "Cookie: inkling_sid=$tok" "$FBASE/api/auth/me")" || fail "the cli-token session does not log in"
in_fresh ./deploy/cli-token.sh list fresh@example.com >/dev/null || fail "cli-token.sh list"
grep -q 'revoked' <<<"$(in_fresh ./deploy/cli-token.sh revoke-all fresh@example.com)" || fail "cli-token.sh revoke-all"
in_fresh ./deploy/backup.sh >/dev/null || fail "backup.sh now"
grep -q . <<<"$(in_fresh ./deploy/backup.sh list)" || fail "backup.sh list"
grep -q lastSuccess <<<"$(in_fresh ./deploy/backup.sh status)" || fail "backup.sh status"
in_fresh ./deploy/restore.sh --dry-run latest >/dev/null || fail "restore.sh --dry-run"
pass "no old name; signup-key, reset-password, cli-token, backup, restore --dry-run work"

log "PASS: $FROM -> $TO"
