# shellcheck shell=bash
# Shared helpers for the backup sidecar scripts. Sourced, not executed.
# Runs inside the postgres:16 (Debian) image: GNU date/tar/coreutils, flock, openssl, perl.
# See docs/BACKUP.md and docs/adr/0600-*.md.

# Backup sets contain every note and password hash: owner-only (the app container reads as root).
umask 077

SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
BACKUP_ROOT="${BACKUP_ROOT:-/backups}"        # sets/ + status.json (app mounts read-only)
CTL_DIR="${BACKUP_CTL_DIR:-/backup-ctl}"      # trigger + app-info (app mounts read-write)
DATA_DIR="${BACKUP_DATA_DIR:-/data}"          # app data volume (uploads, plugins), read-only
SETS_DIR="$BACKUP_ROOT/sets"
STATUS_FILE="$BACKUP_ROOT/status.json"
LOCK_FILE="$BACKUP_ROOT/.lock"
TRIGGER_FILE="$CTL_DIR/run.request"
APP_INFO_FILE="$CTL_DIR/app-info.json"

BACKUP_SCHEDULE="${BACKUP_SCHEDULE:-daily@03:00}"
BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
BACKUP_KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-6}"
BACKUP_RESTORE_TEST_DAYS="${BACKUP_RESTORE_TEST_DAYS:-7}"
BACKUP_MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-256}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"
BACKUP_CIPHER_ARGS=(-aes-256-cbc -pbkdf2 -iter 200000 -md sha256)
BACKUP_CIPHER_LABEL="openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256"
RESTORE_TEST_DB="${BACKUP_RESTORE_TEST_DB:-inkling_restoretest}"

# Every psql / pg_dump / pg_restore of every script that sources this file: disable server-side
# timeouts. The app sets a 15 s statement_timeout per connection, and backups/restores must stay
# immune even if an operator ever sets one at role or database level (client options win).
export PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c statement_timeout=0 -c lock_timeout=0 -c idle_in_transaction_session_timeout=0"

json() { perl "$SCRIPTS_DIR/json.pl" "$@"; }

log() { printf '%s [backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# status_set key=val key:=json ...  (serialised by a separate lock so loop + run can both write)
status_set() {
  mkdir -p "$BACKUP_ROOT"
  (
    flock 8
    json set "$STATUS_FILE" "$@"
  ) 8>"$BACKUP_ROOT/.status.lock"
}

# JSON string literal for arbitrary text (used with key:=...)
jstr() { perl -MJSON::PP -e 'print JSON::PP->new->allow_nonref->encode($ARGV[0])' -- "$1"; }

is_encrypted() { [ -n "${BACKUP_PASSPHRASE:-}" ]; }

# encrypt / decrypt filters (stdin -> stdout). Passphrase is read from the environment,
# never from argv, so it does not show up in `ps`.
enc_filter() { openssl enc -e "${BACKUP_CIPHER_ARGS[@]}" -salt -pass env:BACKUP_PASSPHRASE; }
dec_filter() { openssl enc -d "${BACKUP_CIPHER_ARGS[@]}" -pass env:BACKUP_PASSPHRASE; }

# cat a stored artifact as plaintext (decrypting when it ends in .enc)
cat_plain() {
  local f="$1"
  case "$f" in
    *.enc)
      if ! is_encrypted; then
        echo "set is encrypted but BACKUP_PASSPHRASE is not set" >&2
        return 3
      fi
      dec_filter <"$f"
      ;;
    *) cat "$f" ;;
  esac
}

# pg_restore --list of a stored dump (decrypting when needed). pg_restore stops reading after the
# TOC, so without draining the rest the writer dies of SIGPIPE (exit 141) and, under pipefail,
# every dump larger than the pipe buffer (~64 KiB) would be reported as unreadable. Draining also
# makes openssl decrypt the whole file, so a truncated or corrupt .enc is detected.
pg_toc() {
  cat_plain "$1" | { pg_restore --list && rc=0 || rc=$?; cat >/dev/null; exit "$rc"; }
}

# Set id = UTC timestamp, YYYYMMDD-HHMMSS. Valid ids only (the app enforces the same regex).
valid_set_id() { [[ "$1" =~ ^[0-9]{8}-[0-9]{6}$ ]]; }

set_epoch() {
  local id="$1"
  date -u -d "${id:0:4}-${id:4:2}-${id:6:2} ${id:9:2}:${id:11:2}:${id:13:2}" +%s
}

# Complete local sets (directory with manifest.json), newest first.
list_sets() {
  [ -d "$SETS_DIR" ] || return 0
  find "$SETS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null |
    while read -r id; do
      if valid_set_id "$id" && [ -f "$SETS_DIR/$id/manifest.json" ]; then echo "$id"; fi
    done | sort -r
  return 0
}

# GFS selection. stdin: set ids (any order). stdout: ids to DELETE.
# Keeps the newest set of each of the last KEEP_DAILY days, KEEP_WEEKLY ISO weeks and
# KEEP_MONTHLY months (union, buckets in the container TZ). The newest set is always kept.
gfs_prune_list() {
  local ids id ep d w m first=1
  declare -A keep=() seen_d=() seen_w=() seen_m=()
  local nd=0 nw=0 nm=0
  ids=$(sort -r | grep -E '^[0-9]{8}-[0-9]{6}$' || true)
  for id in $ids; do
    ep=$(set_epoch "$id")
    d=$(date -d "@$ep" +%F)
    w=$(date -d "@$ep" +%G-W%V)
    m=$(date -d "@$ep" +%Y-%m)
    if [ $first = 1 ]; then keep[$id]=1; first=0; fi
    if [ -z "${seen_d[$d]:-}" ] && [ "$nd" -lt "$BACKUP_KEEP_DAILY" ]; then
      seen_d[$d]=1; nd=$((nd + 1)); keep[$id]=1
    fi
    if [ -z "${seen_w[$w]:-}" ] && [ "$nw" -lt "$BACKUP_KEEP_WEEKLY" ]; then
      seen_w[$w]=1; nw=$((nw + 1)); keep[$id]=1
    fi
    if [ -z "${seen_m[$m]:-}" ] && [ "$nm" -lt "$BACKUP_KEEP_MONTHLY" ]; then
      seen_m[$m]=1; nm=$((nm + 1)); keep[$id]=1
    fi
    # a bucket already represented by a newer set is "seen" — mark it so older sets
    # in the same bucket are not picked by a later rule
    seen_d[$d]=1; seen_w[$w]=1; seen_m[$m]=1
  done
  for id in $ids; do
    [ -n "${keep[$id]:-}" ] || echo "$id"
  done
  return 0
}

# rclone binary: PATH, or the static binary copied in by deploy/compose.backup-rclone.yaml
rclone_bin() {
  if command -v rclone >/dev/null 2>&1; then command -v rclone
  elif [ -x /opt/rclone/rclone ]; then echo /opt/rclone/rclone
  else return 1
  fi
}

# Effective configuration, exposed read-only in the admin UI via status.json.
status_config() {
  local remote_tool="none"
  if [ -n "$BACKUP_RCLONE_REMOTE" ]; then
    remote_tool=$(rclone_bin 2>/dev/null || echo "missing")
  fi
  status_set \
    "config.enabled:=$([ "${BACKUP_ENABLED:-1}" = 0 ] && echo false || echo true)" \
    "config.schedule=$BACKUP_SCHEDULE" \
    "config.timezone=${TZ:-UTC}" \
    "config.keepDaily:=$BACKUP_KEEP_DAILY" \
    "config.keepWeekly:=$BACKUP_KEEP_WEEKLY" \
    "config.keepMonthly:=$BACKUP_KEEP_MONTHLY" \
    "config.restoreTestDays:=$BACKUP_RESTORE_TEST_DAYS" \
    "config.minFreeMb:=$BACKUP_MIN_FREE_MB" \
    "config.encrypted:=$(is_encrypted && echo true || echo false)" \
    "config.cipher=$(is_encrypted && echo "$BACKUP_CIPHER_LABEL" || echo none)" \
    "config.remote=${BACKUP_RCLONE_REMOTE}" \
    "config.remoteTool=$remote_tool"
}
