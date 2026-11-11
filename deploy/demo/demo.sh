#!/usr/bin/env bash
# Run the demo instance (docs/DEMO.md), and only the demo instance (0.22 security fix F7, docs/adr/2538-*).
#
#   deploy/demo/demo.sh [--env-file FILE] config      check what would run; changes nothing
#   deploy/demo/demo.sh [--env-file FILE] up          start (or update) the demo
#   deploy/demo/demo.sh [--env-file FILE] build       rebuild the demo's image (DEMO_IMAGE) from this checkout
#   deploy/demo/demo.sh [--env-file FILE] down        stop it; its volumes (data) stay
#   deploy/demo/demo.sh [--env-file FILE] destroy     stop it, delete its volumes and image (asks for the name)
#   deploy/demo/demo.sh [--env-file FILE] ps | logs [args] | exec [args]
#
# Every compose call gets the project name inkling-demo, compose.yaml plus deploy/demo/compose.demo.yaml
# and the demo env file (default deploy/demo/demo.env), and nothing from the shell: COMPOSE_PROJECT_NAME,
# COMPOSE_FILE or INKLING_DATA_NAME in the shell make it stop, and every other shell variable is left out
# (only PATH, HOME and Docker's connection variables are passed). Before `up`, `down` and `destroy` it reads
# the resolved configuration and refuses unless the project is inkling-demo, every volume and the network
# are inkling-demo_*, the database is inkling_demo and no port is 3000 (production's default).
#
# 0.22.1 (contract §15, review N8, docs/adr/2546-*): the app image must be the demo's own (DEMO_IMAGE, a name
# with "demo" in it, never production's ghcr.io/prove1352/inkling), and every volume must be a folder under
# one absolute DEMO_VOLUME_ROOT. Before `up` that folder must exist and sit on a filesystem other than the
# root filesystem's (and Docker's data folder's, when it is on this machine): the operator mounts a
# filesystem with its own size and inode limits there (docs/DEMO.md). DEMO_ALLOW_SHARED_DISK=1 in the
# shell of that one command lets `up` go on with a warning instead (a trial on a laptop, never a public demo).
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
    -h|--help) sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) break ;;
  esac
done
CMD="${1:-}"
[ -n "$CMD" ] || die "which command? config, up, build, down, destroy, ps, logs or exec (--help)"
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

# The one shell variable this script reads itself (never passed to compose): see the top.
ALLOW_SHARED_DISK="${DEMO_ALLOW_SHARED_DISK:-0}"
case "$ALLOW_SHARED_DISK" in 0|1) ;; *) die "DEMO_ALLOW_SHARED_DISK must be 1 or empty" ;; esac

# Docker's data folder, when it is on this machine (Linux): the demo's volumes must not share its disk either.
docker_root() {
  env -i ${KEEP[@]+"${KEEP[@]}"} docker info --format '{{.DockerRootDir}}' 2>/dev/null || true
}

compose() {
  env -i ${KEEP[@]+"${KEEP[@]}"} docker compose --project-directory "$ROOT" -p "$PROJECT" --env-file "$ENV_FILE" \
    -f "$ROOT/compose.yaml" -f "$ROOT/deploy/demo/compose.demo.yaml" "$@"
}

# Read the resolved configuration and check that it is the demo's. Prints one line per check.
gate() {
  command -v python3 >/dev/null 2>&1 || refuse "python3 is needed to check the resolved configuration"
  local json droot=""
  json="$(compose config --format json)" || refuse "docker compose could not read the configuration (see above)"
  [ "${1:-0}" = 1 ] && droot="$(docker_root)"
  # as written in the env file: compose turns a relative path into one under the checkout
  local raw_root
  raw_root="$(sed -n 's/^[[:space:]]*DEMO_VOLUME_ROOT[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\\(.*\\)'$/\\1/")"
  printf '%s' "$json" | python3 -c '
import json, os, sys
project, db_name, strict, allow_shared, docker_root, raw_root = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4] == "1", sys.argv[5], sys.argv[6]
c = json.load(sys.stdin)
bad = []
def say(ok, what):
    print(("ok      " if ok else "REFUSED ") + what)
    if not ok:
        bad.append(what)
say(c.get("name") == project, "project %r (must be %r)" % (c.get("name"), project))
vols = c.get("volumes") or {}
say(len(vols) > 0, "%d volumes" % len(vols))
roots = set()
for key, v in sorted(vols.items()):
    name = (v or {}).get("name", "")
    say(name.startswith(project + "_") and not (v or {}).get("external"), "volume %s = %r (must start with %r)" % (key, name, project + "_"))
    opts = (v or {}).get("driver_opts") or {}
    dev = str(opts.get("device", ""))
    bound = opts.get("o") == "bind" and dev.endswith("/" + key)
    say(bound, "volume %s is the folder %r (must be DEMO_VOLUME_ROOT/%s)" % (key, dev, key))
    if bound:
        roots.add(dev[: -len(key) - 1])
root = next(iter(roots)) if len(roots) == 1 else None
say(root is not None and os.path.isabs(root) and os.path.normpath(root) not in ("/", ""), "every volume is under one DEMO_VOLUME_ROOT (%s)" % (sorted(roots) or "none"))
say(raw_root.startswith("/"), "DEMO_VOLUME_ROOT is written as an absolute path in the env file (%r)" % raw_root)
if strict and root is not None and os.path.isabs(root):
    here = os.path.isdir(root)
    say(here, "DEMO_VOLUME_ROOT %s exists (mount the demo filesystem there first: docs/DEMO.md)" % root)
    if here:
        dev = os.stat(root).st_dev
        others = [("/", "the root filesystem")]
        if docker_root and os.path.isabs(docker_root) and os.path.isdir(docker_root):
            others.append((docker_root, "Docker\x27s data folder " + docker_root))
        shared = [what for p, what in others if os.stat(p).st_dev == dev]
        if not shared:
            say(True, "DEMO_VOLUME_ROOT is a filesystem of its own (device %d)" % dev)
        elif allow_shared:
            print("WARNING DEMO_VOLUME_ROOT %s is on the same filesystem as %s: the demo can fill the disk the rest of this machine uses (DEMO_ALLOW_SHARED_DISK=1)" % (root, " and ".join(shared)))
        else:
            say(False, "DEMO_VOLUME_ROOT %s is on the same filesystem as %s; mount a filesystem with its own size and inode limits there (docs/DEMO.md), or for a trial only run with DEMO_ALLOW_SHARED_DISK=1" % (root, " and ".join(shared)))
for key, n in sorted((c.get("networks") or {}).items()):
    name = (n or {}).get("name", "")
    say(name.startswith(project + "_") and not (n or {}).get("external"), "network %s = %r" % (key, name))
svc = c.get("services") or {}
image = str((svc.get("app") or {}).get("image") or "")
last = image.split("/")[-1]
repo = image.rsplit(":", 1)[0] if ":" in last else image
say("demo" in repo.split("/")[-1] and repo != "ghcr.io/prove1352/inkling", "app image %r (the demo\x27s own name, with demo in it; never production\x27s)" % image)
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
' "$PROJECT" "$DB_NAME" "${1:-0}" "$ALLOW_SHARED_DISK" "$droot" "$raw_root" || refuse "this is not the demo instance's configuration; nothing was done"
}

# A value of the resolved configuration (after gate passed): image | root.
resolved() {
  compose config --format json | python3 -c '
import json, sys
c = json.load(sys.stdin)
if sys.argv[1] == "image":
    print((c.get("services") or {}).get("app", {}).get("image", ""))
else:
    print(str(((c.get("volumes") or {}).get("db") or {}).get("driver_opts", {}).get("device", ""))[: -len("/db")])
' "$1"
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
    root="$(resolved root)"
    for d in db data backups backup-ctl; do mkdir -p "$root/$d" || refuse "could not make $root/$d"; done
    compose up -d
    ;;
  build)
    [ $# -eq 0 ] || die "build takes no arguments"
    gate 0
    compose build app
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
    image="$(resolved image)"
    root="$(resolved root)"
    echo "This stops the demo and deletes its volumes (database, uploads, backups) and its image $image."
    printf 'Type the project name (%s) to go on: ' "$PROJECT"
    read -r answer || answer=""
    [ "$answer" = "$PROJECT" ] || refuse "the name typed was not $PROJECT; nothing was deleted"
    compose down -v
    if env -i ${KEEP[@]+"${KEEP[@]}"} docker image inspect "$image" >/dev/null 2>&1; then
      env -i ${KEEP[@]+"${KEEP[@]}"} docker image rm "$image" >/dev/null && echo "demo.sh: removed the image $image"
    fi
    # The volumes were binds: their files are still in the folders. This script never deletes files on the
    # host; the operator does, after checking the path.
    echo "demo.sh: the demo's files are still in $root/{db,data,backups,backup-ctl}; delete them yourself (as root) once you have checked the path, then unmount the demo filesystem"
    ;;
  ps) compose ps "$@" ;;
  logs) compose logs "$@" ;;
  exec) compose exec "$@" ;;
  *) die "unknown command $CMD (config, up, build, down, destroy, ps, logs, exec)" ;;
esac
