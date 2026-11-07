#!/usr/bin/env bash
# Off-site copy with rclone: upload one set, then apply the same GFS retention to the remote
# independently (NOT `rclone sync`: an empty/new local volume must never wipe remote history).
#
#   remote-sync.sh <set-id>
#
# BACKUP_RCLONE_REMOTE examples: "b2:my-bucket/inkling", "s3:bucket/path", ":local:/mnt/usb".
# Records status.json remote.* (and lastFailure when the upload fails).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

ID="$1"
valid_set_id "$ID" || exit 2
REMOTE="${BACKUP_RCLONE_REMOTE%/}"

remote_fail() {
  log "remote FAILED: $1"
  status_set "remote.at=$(now_iso)" "remote.ok:=false" "remote.message:=$(jstr "$1")" \
    "lastFailure.at=$(now_iso)" "lastFailure.kind=remote" "lastFailure.setId=$ID" \
    "lastFailure.message:=$(jstr "remote copy failed: $1")"
  exit 1
}

RCLONE=$(rclone_bin) || remote_fail "BACKUP_RCLONE_REMOTE is set but no rclone binary is available (use deploy/compose.backup-rclone.yaml)"
RC=("$RCLONE" --config "${RCLONE_CONFIG:-/config/rclone/rclone.conf}" --retries 3 --low-level-retries 5)

log "remote: upload $ID -> $REMOTE/$ID"
# manifest last: a remote set without manifest.json is incomplete and ignored by retention
"${RC[@]}" copy "$SETS_DIR/$ID" "$REMOTE/$ID" --exclude manifest.json 2>&1 | tail -n 5 >&2 ||
  remote_fail "upload failed"
"${RC[@]}" copyto "$SETS_DIR/$ID/manifest.json" "$REMOTE/$ID/manifest.json" 2>&1 | tail -n 5 >&2 ||
  remote_fail "manifest upload failed"
# verify sizes + hashes where the backend supports them
"${RC[@]}" check "$SETS_DIR/$ID" "$REMOTE/$ID" --one-way 2>&1 | tail -n 3 >&2 || remote_fail "rclone check failed"

REMOTE_IDS=$("${RC[@]}" lsf --dirs-only "$REMOTE" 2>/dev/null | sed 's#/$##' | grep -E '^[0-9]{8}-[0-9]{6}$' || true)
COMPLETE=""
for rid in $REMOTE_IDS; do
  if "${RC[@]}" lsf "$REMOTE/$rid" 2>/dev/null | grep -x manifest.json >/dev/null; then COMPLETE="$COMPLETE $rid"; fi
done
PRUNED=0
for old in $(printf '%s\n' $COMPLETE | gfs_prune_list); do
  log "remote: prune $old"
  "${RC[@]}" purge "$REMOTE/$old" >/dev/null 2>&1 && PRUNED=$((PRUNED + 1)) || log "remote: prune of $old failed"
done
KEPT=$(( $(printf '%s\n' $COMPLETE | grep -c . || true) - PRUNED ))
status_set "remote.at=$(now_iso)" "remote.ok:=true" "remote.setId=$ID" "remote.setCount:=$KEPT" \
  "remote.message:=$(jstr "uploaded $ID, $KEPT set(s) on remote, pruned $PRUNED")"
log "remote ok: $KEPT set(s) on remote, pruned $PRUNED"
