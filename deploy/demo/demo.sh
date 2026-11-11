#!/usr/bin/env bash
# Run the demo instance (docs/DEMO.md), and only the demo instance (0.22 security fix F7, docs/adr/2538-*).
#
#   deploy/demo/demo.sh [--env-file FILE] config      check what would run; changes nothing
#   deploy/demo/demo.sh [--env-file FILE] up          start (or update) the demo
#   deploy/demo/demo.sh [--env-file FILE] down        stop it; its volumes (data) stay
#   deploy/demo/demo.sh [--env-file FILE] destroy     stop it and delete its volumes (asks for the name)
#   deploy/demo/demo.sh [--env-file FILE] ps | logs [args] | exec [args]
#
# Every compose call gets the project name inkling-demo, compose.yaml plus deploy/demo/compose.demo.yaml
# and the demo env file (default deploy/demo/demo.env), and nothing from the shell: COMPOSE_PROJECT_NAME,
# COMPOSE_FILE or INKLING_DATA_NAME in the shell make it stop, and every other shell variable is left out
# (only PATH, HOME and Docker's connection variables are passed). Before `up`, `down` and `destroy` it reads
# the resolved configuration and refuses unless the project is inkling-demo, every volume and the network
# are inkling-demo_*, the database is inkling_demo and no port is 3000 (production's default).
set -euo pipefail

PROJECT=inkling-demo
DB_NAME=inkling_demo
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/demo/demo.env"

die() { echo "demo.sh: $*" >&2; exit 2; }
refuse() { echo "demo.sh: refused: $*" >&2; exit 3; }

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) [ $# -ge 2 ] || die "--env-file needs a file"; ENV_FILE="$2"; shift 2 ;;
    --env-file=*) ENV_FILE="${1#--env-file=}"; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) break ;;
  esac
done
CMD="${1:-}"
[ -n "$CMD" ] || die "which command? config, up, down, destroy, ps, logs or exec (--help)"
shift

# The production instance is named by these: a demo command must never see them.
for v in COMPOSE_PROJECT_NAME COMPOSE_FILE INKLING_DATA_NAME; do
  if [ -n "${!v+x}" ]; then
    die "$v is set in this shell ($v=${!v}). It names the production instance; run without it, e.g. env -u $v deploy/demo/demo.sh $CMD"
  fi
done
[ -f "$ENV_FILE" ] || die "no env file $ENV_FILE (cp deploy/demo/demo.env.example deploy/demo/demo.env, then fill it in)"
case "$ENV_FILE" in /*) ;; *) ENV_FILE="$PWD/$ENV_FILE" ;; esac

# Only these reach docker compose; everything else in the shell (passwords, PUBLIC_URL, limits) is ignored.
KEEP=()
for v in PATH HOME USER LOGNAME LANG LC_ALL TERM TMPDIR XDG_RUNTIME_DIR SSH_AUTH_SOCK \
         DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_CERT_PATH DOCKER_TLS_VERIFY DOCKER_API_VERSION; do
  if [ -n "${!v+x}" ]; then KEEP+=("$v=${!v}"); fi
done

# Marks a compose call made by this script (compose.demo.yaml requires it).
KEEP+=("DEMO_VIA_SCRIPT=1")

compose() {
  env -i ${KEEP[@]+"${KEEP[@]}"} docker compose --project-directory "$ROOT" -p "$PROJECT" --env-file "$ENV_FILE" \
    -f "$ROOT/compose.yaml" -f "$ROOT/deploy/demo/compose.demo.yaml" "$@"
}

# Read the resolved configuration and check that it is the demo's. Prints one line per check.
gate() {
  command -v python3 >/dev/null 2>&1 || refuse "python3 is needed to check the resolved configuration"
  local json
  json="$(compose config --format json)" || refuse "docker compose could not read the configuration (see above)"
  printf '%s' "$json" | python3 -c '
import json, sys
project, db_name, strict = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
c = json.load(sys.stdin)
bad = []
def say(ok, what):
    print(("ok      " if ok else "REFUSED ") + what)
    if not ok:
        bad.append(what)
say(c.get("name") == project, "project %r (must be %r)" % (c.get("name"), project))
vols = c.get("volumes") or {}
say(len(vols) > 0, "%d volumes" % len(vols))
for key, v in sorted(vols.items()):
    name = (v or {}).get("name", "")
    say(name.startswith(project + "_") and not (v or {}).get("external"), "volume %s = %r (must start with %r)" % (key, name, project + "_"))
for key, n in sorted((c.get("networks") or {}).items()):
    name = (n or {}).get("name", "")
    say(name.startswith(project + "_") and not (n or {}).get("external"), "network %s = %r" % (key, name))
svc = c.get("services") or {}
dbenv = (svc.get("db") or {}).get("environment") or {}
say(dbenv.get("POSTGRES_DB") == db_name and dbenv.get("POSTGRES_USER") == db_name, "database %r, role %r (must be %r)" % (dbenv.get("POSTGRES_DB"), dbenv.get("POSTGRES_USER"), db_name))
url = ((svc.get("app") or {}).get("environment") or {}).get("DATABASE_URL", "")
say(url.startswith("postgres://%s:" % db_name) and url.endswith("@db:5432/%s" % db_name), "app database URL points at %r" % db_name)
benv = (svc.get("backup") or {}).get("environment") or {}
say(benv.get("PGDATABASE") == db_name and benv.get("PGUSER") == db_name, "backups read %r" % benv.get("PGDATABASE"))
for s_name, s in sorted(svc.items()):
    for p in (s or {}).get("ports") or []:
        pub = str(p.get("published", ""))
        say(pub != "3000", "service %s publishes %s:%s (3000 is the production port)" % (s_name, p.get("host_ip") or "0.0.0.0", pub))
    if s_name == "db":
        say(not (s or {}).get("ports"), "the database publishes no port")
print("info    public address %r" % (((svc.get("app") or {}).get("environment") or {}).get("PUBLIC_URL")))
if strict:
    env = (svc.get("app") or {}).get("environment") or {}
    say("CHANGE-ME" not in (env.get("APP_SECRET_KEY") or "") and "CHANGE-ME" not in dbenv.get("POSTGRES_PASSWORD", ""), "secrets filled in (no CHANGE-ME)")
sys.exit(3 if bad else 0)
' "$PROJECT" "$DB_NAME" "${1:-0}" || refuse "this is not the demo instance's configuration; nothing was done"
}

case "$CMD" in
  config)
    [ $# -eq 0 ] || die "config takes no arguments"
    gate 0
    echo "demo.sh: the configuration is the demo's (project $PROJECT, env file $ENV_FILE)"
    ;;
  up)
    [ $# -eq 0 ] || die "up takes no arguments"
    gate 1
    compose up -d
    ;;
  down)
    # never -v: the demo's data stays (destroy deletes it)
    [ $# -eq 0 ] || die "down takes no arguments (to delete the data: destroy)"
    gate 0
    compose down
    ;;
  destroy)
    [ $# -eq 0 ] || die "destroy takes no arguments"
    gate 0
    echo "This stops the demo and deletes its volumes (database, uploads, backups) for good."
    printf 'Type the project name (%s) to go on: ' "$PROJECT"
    read -r answer || answer=""
    [ "$answer" = "$PROJECT" ] || refuse "the name typed was not $PROJECT; nothing was deleted"
    compose down -v
    ;;
  ps) compose ps "$@" ;;
  logs) compose logs "$@" ;;
  exec) compose exec "$@" ;;
  *) die "unknown command $CMD (config, up, down, destroy, ps, logs, exec)" ;;
esac
