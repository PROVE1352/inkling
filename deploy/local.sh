#!/usr/bin/env bash
# Try Inkling on this machine in one command (docs/adr/2160-*, 2161-*).
#
#   ./deploy/local.sh            # first run: write .env (random secrets, a free port), start, print the setup link
#   ./deploy/local.sh --build    # same, but build the image from this checkout instead of pulling it
#   ./deploy/local.sh stop       # stop the containers (data stays)
#   ./deploy/local.sh destroy    # stop and delete this trial's containers and data volumes
#
# What it writes: a .env marked "made by deploy/local.sh" with POSTGRES_PASSWORD and APP_SECRET_KEY
# from openssl, PUBLIC_URL=http://localhost:<port>, INKLING_PORT=127.0.0.1:<port> (reachable from this
# machine only), BACKUP_ENABLED=0, INKLING_DATA_NAME=inkling, and COMPOSE_FILE / COMPOSE_PROJECT_NAME so
# that plain `docker compose …` and the other deploy/*.sh scripts act on this stack. A .env it did not
# write is never changed: then it stops and says why. A trial started before 0.19 keeps its data: its .env
# gets INKLING_DATA_NAME=nodian (the old volume and database names, docs/adr/2340-*).
#
# The first account: with no account yet the server prints a one-time /setup?code=… link to its log;
# this script shows it. That link, not "requests from localhost", is what lets the first admin in.
#
# Environment: INKLING_PORT=3987 picks the port; INKLING_LOCAL_PROJECT=name picks the compose project
# (default inkling-local). Both only matter when the .env is first written.
set -euo pipefail
cd "$(dirname "$0")/.."

MARKER='# made by deploy/local.sh'
PROJECT="${INKLING_LOCAL_PROJECT:-inkling-local}"

die() { printf 'local.sh: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$2"; }

need docker 'Docker is not installed (https://docs.docker.com/get-docker/).'
docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is missing ("docker compose version" fails).'
docker info >/dev/null 2>&1 || die 'Docker is installed but not running. Start Docker Desktop (or the docker service) and run this again.'

# Value of KEY= in .env (read with sed, never sourced).
env_get() {
  [[ -f .env ]] || return 0
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*[\"']?([^\"'#]*).*/\1/p" .env | tr -d '\r' | tail -n 1 | sed -E 's/[[:space:]]+$//'
}

# Something already listens on 127.0.0.1:<port>?
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

free_port() {
  local p
  for p in 3000 3987 3001 3002 3003 3004 3005 3006 3007 3008 3009 3010; do
    port_busy "$p" || { echo "$p"; return 0; }
  done
  die 'no free port among 3000, 3987, 3001-3010; set INKLING_PORT=<port> and run again.'
}

secret_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; fi
}
secret_b64() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1"
  else head -c "$1" /dev/urandom | base64 | tr -d '\n'; fi
}

compose_files() {
  if [[ "${1:-}" == build ]]; then echo 'compose.yaml:compose.local.yaml:compose.build.yaml'
  else echo 'compose.yaml:compose.local.yaml'; fi
}

write_env() {
  local port="$1" files="$2"
  # Hex for the database password: it goes into a postgres:// URL, where / + = would need escaping.
  umask 077
  cat >.env <<EOF
$MARKER — a local trial, reachable from this machine only. For a real server see deploy/DEPLOY.md.
# All settings: .env.example. Change the port: stop, edit INKLING_PORT and PUBLIC_URL together, start.
COMPOSE_PROJECT_NAME=$PROJECT
COMPOSE_FILE=$files
# Volume, database role and database names (docs/adr/2340-*).
INKLING_DATA_NAME=inkling
INKLING_PORT=127.0.0.1:$port
PUBLIC_URL=http://localhost:$port
COOKIE_SECURE=0
# Generated. Postgres reads the password only when it creates the data volume: keep it with the data.
POSTGRES_PASSWORD=$(secret_hex 24)
# Encrypts two-step verification secrets and stored link secrets (docs/adr/1061-*).
APP_SECRET_KEY=$(secret_b64 32)
BACKUP_ENABLED=0
EOF
}

set_env_line() { # KEY VALUE: replace the line in our own .env
  local tmp
  tmp="$(mktemp)"
  grep -v "^$1=" .env >"$tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$tmp"
  cat "$tmp" >.env
  rm -f "$tmp"
}

cmd="${1:-up}"
build=''
if [[ "$cmd" == --build ]]; then cmd=up; build=build; fi
if [[ "${2:-}" == --build ]]; then build=build; fi

if [[ -f .env ]] && ! grep -qF "$MARKER" .env; then
  die '.env exists and was not written by this script; it is left alone. Run docker compose with your own .env (deploy/DEPLOY.md), or move .env away to start a local trial.'
fi

# A trial from before 0.19: its volumes and database use the old name. Pin it so it keeps its data
# (deploy/rename-from-nodian.sh moves it to the new names later, if wanted).
if [[ -f .env && -z "$(env_get INKLING_DATA_NAME)" ]]; then
  set_env_line INKLING_DATA_NAME nodian
  echo 'This trial was started before 0.19: added INKLING_DATA_NAME=nodian to .env so it keeps its data.'
fi

case "$cmd" in
  up) ;;
  stop)
    [[ -f .env ]] || die 'nothing to stop (no .env from this script).'
    docker compose stop
    exit 0
    ;;
  destroy)
    [[ -f .env ]] || die 'nothing to delete (no .env from this script).'
    docker compose down -v --remove-orphans
    echo "Deleted the containers and data volumes of $(env_get COMPOSE_PROJECT_NAME). The .env stays (delete it to start over with new secrets)."
    exit 0
    ;;
  *)
    sed -n '2,20p' "$0"
    exit 1
    ;;
esac

if [[ ! -f .env ]]; then
  port="${INKLING_PORT:-}"
  if [[ -z "$port" ]]; then port="$(free_port)"
  elif port_busy "$port"; then die "port $port is in use; pick another INKLING_PORT."; fi
  write_env "$port" "$(compose_files "$build")"
  echo "Wrote .env (project $PROJECT, port $port, generated secrets)."
else
  port="$(env_get INKLING_PORT)"
  port="${port##*:}"
  # --build switches this stack to source builds for good; without it the earlier choice stays
  # (a plain re-run after --build must not swap in the published image).
  if [[ -n "$build" ]]; then set_env_line COMPOSE_FILE "$(compose_files build)"
  elif [[ "$(env_get COMPOSE_FILE)" == *compose.build.yaml* ]]; then build=build; fi
fi
url="$(env_get PUBLIC_URL)"
url="${url:-http://localhost:$port}"

running="$(docker compose ps -q app 2>/dev/null || true)"
if [[ -z "$running" ]] && port_busy "$port"; then
  die "port $port is in use by something else. Stop it, or edit INKLING_PORT and PUBLIC_URL in .env."
fi

start=$(date +%s)
if [[ -n "$build" ]]; then
  echo 'Building the image from this checkout (a few minutes the first time)…'
  docker compose up -d --build
else
  echo 'Pulling the image (once) and starting…'
  docker compose up -d
fi

printf 'Waiting for %s ' "$url"
ok=''
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then ok=1; break; fi
  printf '.'
  sleep 2
done
echo
if [[ -z "$ok" ]]; then
  docker compose logs --tail 40 app >&2 || true
  die "the app did not answer within 3 minutes (logs above; more with: docker compose logs app)."
fi
echo "Up in $(( $(date +%s) - start )) s."

# The newest setup link in the log (a restart prints a new code; the old one stops working).
link=''
if curl -fsS "http://127.0.0.1:$port/api/auth/mode" 2>/dev/null | grep -q '"setupPending":true'; then
  link="$(docker compose logs --no-log-prefix app 2>/dev/null | grep -Eo 'https?://[^ ]+/setup\?code=[A-Z0-9-]+' | tail -n 1 || true)"
fi
echo
if [[ -n "$link" ]]; then
  echo "  Create your administrator account (one-time link):"
  echo "    $link"
else
  echo "  Open $url and sign in. New people need a signup key: ./deploy/signup-key.sh new \"name\""
  echo "  (No account yet and no setup link in the logs? The image predates 0.17: make the first key the same way.)"
fi
echo
echo "  Connect an AI agent (MCP): open $url/settings/connections, issue an agent token, then use"
echo "    URL   $url/mcp"
echo "    e.g.  claude mcp add --transport http inkling $url/mcp --header \"Authorization: Bearer <token>\""
echo
echo "  Logs: docker compose logs -f app    Stop: ./deploy/local.sh stop    Delete everything: ./deploy/local.sh destroy"
