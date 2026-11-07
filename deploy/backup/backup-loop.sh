#!/usr/bin/env bash
# Backup sidecar main loop (container entrypoint). No cron: a sleep loop that
#   - runs a scheduled backup when BACKUP_SCHEDULE says so,
#   - runs an on-demand backup when the app drops $BACKUP_CTL_DIR/run.request,
#   - writes a heartbeat + next run time into status.json for the admin UI.
#
# BACKUP_SCHEDULE: daily@HH:MM | hourly@MM | every@<N>m | every@<N>h | off (manual only)
# BACKUP_ENABLED=0 turns the sidecar into a no-op (status "disabled", triggers ignored).
set -uo pipefail
source "$(dirname "$0")/lib.sh"

mkdir -p "$SETS_DIR" "$CTL_DIR"
CHILD=""
on_term() {
  log "stopping"
  [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null && wait "$CHILD" 2>/dev/null
  status_set "running:=null" "heartbeatAt=$(now_iso)" "stoppedAt=$(now_iso)"
  exit 0
}
trap on_term TERM INT

# next_run <now-epoch> -> epoch of the next scheduled run, or empty for "off"
next_run() {
  local now="$1" s="$BACKUP_SCHEDULE" t hh mm n
  case "$s" in
    off|manual|"") echo "" ;;
    daily@[0-2][0-9]:[0-5][0-9])
      hh=${s:6:2}; mm=${s:9:2}
      t=$(date -d "today $hh:$mm" +%s)
      [ "$t" -gt "$now" ] || t=$(date -d "tomorrow $hh:$mm" +%s)
      echo "$t" ;;
    hourly@[0-5][0-9])
      mm=${s:7:2}
      t=$(date -d "$(date -d "@$now" '+%F %H'):$mm" +%s)
      [ "$t" -gt "$now" ] || t=$((t + 3600))
      echo "$t" ;;
    every@[0-9]*m) n=${s#every@}; n=${n%m}; echo $(( now + n * 60 )) ;;
    every@[0-9]*h) n=${s#every@}; n=${n%h}; echo $(( now + n * 3600 )) ;;
    *) log "invalid BACKUP_SCHEDULE '$s' (use daily@HH:MM, hourly@MM, every@Nm, every@Nh, off)"; echo "invalid" ;;
  esac
}

iso_of() { [ -n "$1" ] && date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

run_backup() { # kind
  bash "$SCRIPTS_DIR/backup-run.sh" --kind "$1" &
  CHILD=$!
  wait "$CHILD"
  local rc=$?
  CHILD=""
  [ "$rc" = 75 ] && log "skipped: lock busy"
  return 0
}

status_config
if [ "${BACKUP_ENABLED:-1}" = 0 ]; then
  log "BACKUP_ENABLED=0 - idle"
  status_set "running:=null" "nextRunAt:=null" "heartbeatAt=$(now_iso)" "stoppedAt:=null"
  while true; do sleep 3600 & wait $!; status_set "heartbeatAt=$(now_iso)"; done
fi

NEXT=$(next_run "$(date +%s)")
if [ "$NEXT" = invalid ]; then
  status_set "lastFailure.at=$(now_iso)" "lastFailure.kind=config" \
    "lastFailure.message:=$(jstr "invalid BACKUP_SCHEDULE '$BACKUP_SCHEDULE'")"
  NEXT=""
fi
# a run that was interrupted by a container restart leaves running != null
status_set "running:=null" "startedAt=$(now_iso)" "stoppedAt:=null" \
  "nextRunAt:=$([ -n "$NEXT" ] && jstr "$(iso_of "$NEXT")" || echo null)"
log "started: schedule=$BACKUP_SCHEDULE next=$([ -n "$NEXT" ] && iso_of "$NEXT" || echo none) tz=${TZ:-UTC}"

LAST_BEAT=0
while true; do
  now=$(date +%s)
  if [ -f "$TRIGGER_FILE" ]; then
    # consume first so a click during the run queues exactly one more run
    mv -f "$TRIGGER_FILE" "$CTL_DIR/run.processing" 2>/dev/null || true
    log "manual backup requested: $(tr -d '\n' <"$CTL_DIR/run.processing" 2>/dev/null | cut -c1-200)"
    run_backup manual
    rm -f "$CTL_DIR/run.processing"
  fi
  if [ -n "$NEXT" ] && [ "$now" -ge "$NEXT" ]; then
    run_backup scheduled
    NEXT=$(next_run "$(date +%s)")
    status_set "nextRunAt:=$([ -n "$NEXT" ] && jstr "$(iso_of "$NEXT")" || echo null)"
  fi
  if [ $((now - LAST_BEAT)) -ge 60 ]; then
    status_set "heartbeatAt=$(now_iso)"
    LAST_BEAT=$now
  fi
  sleep 5 & wait $!
done
