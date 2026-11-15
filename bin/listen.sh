#!/bin/sh
# listen.sh [--once] - the Mac's connection to the web page (LaunchAgent com.macwatch.listen,
# KeepAlive). It polls the Worker: every POLL_SLOW_SEC (20 s) normally, every POLL_FAST_SEC
# (2 s) while the page is open. Each poll answers with plain lines:
#     fast 1 | live 1 | cmd <id> <snap|record|pause|resume> <unix-time> | set KEY=number
# and listen.sh runs the commands (each id at most once), applies the settings through the
# strict whitelist in lib.sh, acks, takes live frames while Live is on, and posts status.json.
#
# Same gate as everything else: the local PAUSE file stops it completely (no polling at all),
# a closed lid stops polling, a remote pause keeps polling so Resume can reach us.
#   --once   one poll, no loop (tests, selftest)
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
# shellcheck source=api.sh
. "$MW_BIN/api.sh"
mw_init listen

once=0
[ "${1:-}" = --once ] && once=1

if ! lock_acquire listen 100000; then
  debug "listen: another listen.sh is running"
  [ "$once" = 1 ] || sleep 30     # KeepAlive would restart us at once; do not spin
  exit 0
fi
out=$MW_TMP/poll.$$
cmds=$MW_TMP/cmds.$$
sets=$MW_TMP/sets.$$
body=$MW_TMP/body.$$
# shellcheck disable=SC2329  # called by trap
cleanup() { rm -f "$out" "$cmds" "$sets" "$body" "$MW_TMP/remote.cand.$$" "$MW_TMP/live.$$".*; lock_release listen; }
trap cleanup EXIT
trap 'exit 0' INT TERM HUP

dirty=1          # post status.json on the first successful poll
sleep_for=$POLL_SLOW_SEC

reach() { # ok|fail MESSAGE   (log changes only, so an offline Mac does not fill the log)
  _prev=$(cat "$MW_STATE/worker-reach" 2>/dev/null)
  if [ "$1" = ok ]; then
    [ "$_prev" = ok ] || log INFO "connected to the Worker"
    echo ok > "$MW_STATE/worker-reach"
    now > "$MW_STATE/last-poll-ok"
    clear_error listen
  else
    if [ "$_prev" != "fail $API_CODE" ]; then
      case $API_CODE in
        000) log INFO "$2" ;;
        *)   note_error listen "$2" ;;
      esac
    fi
    echo "fail $API_CODE" > "$MW_STATE/worker-reach"
  fi
}

ack() { # ID
  printf '%s' "$1" > "$body"
  api POST /mac/ack "$out.ack" "$body" || log WARN "ack $1 failed (HTTP $API_CODE); the Worker will resend it and it will be skipped"
  rm -f "$out.ack"
}

# ---------------------------------------------------------------- settings --
apply_sets() {
  if [ ! -s "$sets" ]; then
    if [ -e "$MW_STATE/remote.conf" ]; then
      rm -f "$MW_STATE/remote.conf"
      log INFO "no settings from the web page any more: back to config.env"
      mw_load_config; dirty=1
    fi
    return 0
  fi
  _res=$(apply_remote_config "$sets" "$MW_TMP/remote.cand.$$")
  if ! cmp -s "$MW_TMP/remote.cand.$$" "$MW_STATE/remote.conf" 2>/dev/null; then
    mv "$MW_TMP/remote.cand.$$" "$MW_STATE/remote.conf"
    log INFO "settings from the web page changed: $_res ($(tr '\n' ' ' < "$MW_STATE/remote.conf"))"
    mw_load_config; dirty=1
  fi
  rm -f "$MW_TMP/remote.cand.$$"
}

# ---------------------------------------------------------------- commands --
# Recordings run as their own on-demand LaunchAgent so they outlive this loop
# and get normal signal handling. See bin/record.sh.
start_recording() { # LABEL
  if [ -d "$MW_STATE/record.lock" ]; then
    log INFO "$1: a recording is already running, ignoring"
    return 0
  fi
  printf '%s' "$1" > "$MW_STATE/record-request"
  if ! launchctl kickstart "gui/$(id -u)/com.macwatch.record" > "$body" 2>&1; then
    note_error record "could not start the recording agent (run ./bin/install.sh again?): $(head -c 200 "$body" | tr '\n' ' ')"
    rm -f "$MW_STATE/record-request"
  fi
}

run_cmds() {
  [ -s "$cmds" ] || return 0
  _last=$(cat "$MW_STATE/last-cmd" 2>/dev/null)
  case $_last in ''|*[!0-9]*) _last=0 ;; esac
  _snap=0
  while IFS=' ' read -r _id _name _t <&3; do
    case $_id in ''|*[!0-9]*) continue ;; esac
    case $_t in ''|*[!0-9]*) _t=0 ;; esac
    if [ "$_id" -le "$_last" ]; then ack "$_id"; continue; fi     # already handled: at most once
    echo "$_id" > "$MW_STATE/last-cmd"; _last=$_id
    _age=$(( $(now) - _t ))
    case $_name in
      pause|resume) ;;                       # a late pause is the safe direction; resume must always work
      *) if [ "$_age" -gt $((MARKER_MAX_AGE_MIN * 60)) ]; then
           log INFO "command $_id $_name is $(age_str "$_age") old (limit ${MARKER_MAX_AGE_MIN}m): not acted on"
           ack "$_id"; continue
         fi ;;
    esac
    case $_name in
      pause)  date +%s > "$MW_STATE/remote-paused"; log INFO "command $_id: paused from the web page"; dirty=1 ;;
      resume) rm -f "$MW_STATE/remote-paused"; log INFO "command $_id: resumed from the web page"; dirty=1 ;;
      snap|record)
        if paused_remote; then
          log INFO "command $_id $_name: ignored because capturing is paused remotely"
        elif [ "$_name" = snap ]; then
          log INFO "command $_id: screenshot now"
          "$MW_BIN/trigger.sh" remote && _snap=1
        else
          log INFO "command $_id: starting a ${RECORD_SEC}s recording"
          start_recording "cmd-$_id"
        fi ;;
      *) log WARN "command $_id: unknown command '$_name', ignored" ;;
    esac
    ack "$_id"
  done 3< "$cmds"
  # send the new shot at once instead of waiting for the next batch
  if [ "$_snap" = 1 ]; then "$MW_BIN/upload.sh" --now; dirty=1; fi
}

# ---------------------------------------------------------------- live view --
live_frame() {
  _l=$(cat "$MW_STATE/last-live" 2>/dev/null)
  case $_l in ''|*[!0-9]*) _l=0 ;; esac
  [ $(($(now) - _l)) -ge "$LIVE_EVERY_SEC" ] || return 0
  gate quiet || return 0
  now > "$MW_STATE/last-live"
  _name=$(date +%Y%m%d-%H%M%S).jpg
  _raw=$MW_TMP/live.$$.raw
  _fin=$MW_TMP/live.$$.jpg
  # shellcheck disable=SC2086  # SCREENCAPTURE_EXTRA is meant to word-split
  screencapture -x -t jpg $SCREENCAPTURE_EXTRA "$_raw" 2>/dev/null
  if [ ! -s "$_raw" ]; then rm -f "$_raw"; debug "live: screencapture failed"; return 0; fi
  sips --resampleWidth 640 -s format jpeg -s formatOptions 40 "$_raw" --out "$_fin" >/dev/null 2>&1 || cp "$_raw" "$_fin"
  if rc copyto "$_fin" "$(rpath live)/$_name" --no-check-dest 2> "$body"; then
    printf 'live/%s %s' "$_name" "$(file_size "$_fin")" > "$body"
    api POST /mac/live "$out.live" "$body" || debug "live: registering the frame failed (HTTP $API_CODE)"
    rm -f "$out.live"
  else
    log WARN "live: upload failed: $(tail -n 2 "$body" | redact | tr '\n' ' ')"
  fi
  rm -f "$_raw" "$_fin"
}

# ---------------------------------------------------------------- status ----
push_status() {
  _last=$(cat "$MW_STATE/last-status-push" 2>/dev/null)
  case $_last in ''|*[!0-9]*) _last=0 ;; esac
  [ "$dirty" = 1 ] || [ $(($(now) - _last)) -ge "$STATUS_EVERY_SEC" ] || return 0
  "$MW_BIN/report.sh" || return 0
  if api POST /mac/status "$out.status" "$MW_STATE/status.json"; then
    now > "$MW_STATE/last-status-push"
    dirty=0
  else
    debug "status push failed (HTTP $API_CODE)"
  fi
  rm -f "$out.status"
}

# ---------------------------------------------------------------- one tick --
tick() {
  sleep_for=$POLL_SLOW_SEC
  rotate_log "$MW_LOG/listen.log"
  mw_load_config
  paused_local && return 0                 # PAUSE file: no network at all
  lid_open || return 0
  if ! api_configured; then
    if [ ! -e "$MW_STATE/listen-unconfigured" ]; then
      : > "$MW_STATE/listen-unconfigured"
      note_error listen "not set up yet: run ./bin/setup-remote.sh (needs WORKER_URL in config.env and the Mac token)"
    fi
    return 0
  fi
  rm -f "$MW_STATE/listen-unconfigured"
  if paused_remote; then _pz=remote; else _pz=no; fi
  if ! api GET "/mac/poll?paused=$_pz" "$out"; then
    reach fail "$(api_problem "$API_CODE")"
    return 0
  fi
  reach ok
  _fast=0; _live=0
  : > "$cmds"; : > "$sets"
  while IFS= read -r _line || [ -n "$_line" ]; do
    _line=$(printf '%s' "$_line" | tr -d '\r')
    case $_line in
      "fast 1") _fast=1 ;;
      "live 1") _live=1 ;;
      "cmd "*)  printf '%s\n' "${_line#cmd }" >> "$cmds" ;;
      "set "*)  printf '%s\n' "${_line#set }" >> "$sets" ;;
      *) ;;                                 # unknown lines: ignored (forward compatible)
    esac
  done < "$out"
  apply_sets
  run_cmds
  if [ "$_live" = 1 ] && ! paused_remote; then live_frame; fi
  push_status
  if [ "$_fast" = 1 ] || [ "$_live" = 1 ]; then sleep_for=$POLL_FAST_SEC; fi
  echo "$sleep_for" > "$MW_STATE/poll-interval"
}

if [ "$once" = 1 ]; then
  tick
  exit 0
fi
log INFO "listen started (pid $$)"
while :; do
  tick
  sleep "$sleep_for"
done
