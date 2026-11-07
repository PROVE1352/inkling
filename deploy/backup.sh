#!/usr/bin/env bash
# Inkling backups from the host. The work is done by the `backup` sidecar service
# (compose.yaml, scripts in deploy/backup/); this is a thin convenience wrapper.
#
#   ./deploy/backup.sh                    take a backup now (same as the admin "Back up now")
#   ./deploy/backup.sh list               list backup sets
#   ./deploy/backup.sh status             print status.json
#   ./deploy/backup.sh verify <set>       re-check sha256 + readability of a set
#   ./deploy/backup.sh restore-test [set] restore into a temporary database and compare row counts
#   ./deploy/backup.sh copy-out <set> DIR copy a set out of the volume to a host directory
#
# Restoring: ./deploy/restore.sh (see docs/BACKUP.md).
# Override the compose command with COMPOSE="docker compose -f ... -f ...".
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -a DC <<<"${COMPOSE:-docker compose}"
in_sidecar() { "${DC[@]}" exec -T backup "$@"; }

"${DC[@]}" ps --status running --services 2>/dev/null | grep -x backup >/dev/null || {
  echo "the backup service is not running: ${DC[*]} up -d backup" >&2
  exit 1
}

case "${1:-now}" in
  now) in_sidecar bash /scripts/backup-run.sh --kind manual ;;
  list) in_sidecar bash -c 'cd /backups/sets 2>/dev/null && for d in */; do d=${d%/}; [ -f "$d/manifest.json" ] && printf "%s  %10s bytes  %s\n" "$d" "$(perl /scripts/json.pl get "$d/manifest.json" totalBytes)" "$(perl /scripts/json.pl get "$d/manifest.json" kind)"; done | sort -r' ;;
  status) in_sidecar cat /backups/status.json ;;
  verify) in_sidecar bash /scripts/restore-helper.sh verify "${2:?set id}" ;;
  restore-test) in_sidecar bash /scripts/restore-test.sh ${2:+"$2"} ;;
  copy-out)
    id="${2:?set id}"; dest="${3:?destination dir}"
    [[ "$id" =~ ^[0-9]{8}-[0-9]{6}$ ]] || { echo "bad set id" >&2; exit 2; }
    mkdir -p "$dest"
    docker cp "$("${DC[@]}" ps -q backup):/backups/sets/$id" "$dest/"
    echo "copied to $dest/$id" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
