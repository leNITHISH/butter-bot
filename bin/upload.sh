#!/bin/sh
# upload.sh [--now] - runs every CONTROL_POLL_SEC (and when the network config changes).
#   1. gate (lid open, no local PAUSE); optional KEEP_AWAKE; keep Hammerspoon alive
#   2. housekeeping: queue cap, old temp files          (also works while offline)
#   3. online check; exit quietly when offline
#   4. flush queue/ to Backblaze B2 (rclone move) in batches of UPLOAD_EVERY_SEC,
#      then tell the Worker which files arrived (POST /mac/index) so the web page lists them
#   --now   upload everything at once (listen.sh uses it right after "Screenshot now")
# Deleting old files is the Worker's job now (retention + storage guard); nothing here deletes
# anything in the bucket.
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
# shellcheck source=api.sh
. "$MW_BIN/api.sh"
mw_init upload

now_mode=0
[ "${1:-}" = --now ] && now_mode=1

# The local PAUSE file stops everything. A remote pause stops uploads too (listen.sh
# keeps polling so that Resume can reach us).
paused_local && exit 0
lid_open || exit 0

if [ "$now_mode" = 0 ]; then
  # ---------------------------------------------------------- keep awake ----
  # Optional (KEEP_AWAKE=1). Each run starts a short caffeinate that expires on
  # its own, so closing the lid (which stops this job) releases the hold within
  # a few minutes. Needs AbandonProcessGroup in the plist so launchd leaves it be.
  if [ "$KEEP_AWAKE" = 1 ] && ! paused_remote && command -v caffeinate >/dev/null 2>&1; then
    caffeinate -di -t $((CONTROL_POLL_SEC * 3)) >/dev/null 2>&1 &
  fi
  "$MW_BIN/heartbeat.sh" power
  # Phase 3 helper: keep Hammerspoon running (only if install.sh --hammerspoon enabled it).
  if [ -e "$MW_STATE/hammerspoon-enabled" ] && ! pgrep -x Hammerspoon >/dev/null 2>&1; then
    log WARN "Hammerspoon is not running; starting it"
    open -g -a Hammerspoon >/dev/null 2>&1
  fi
fi

# --now waits for a running batch (up to 30 s) instead of giving up.
_i=0
until lock_acquire upload 10; do
  if [ "$now_mode" = 0 ] || [ "$_i" -ge 30 ]; then debug "upload: previous run still going"; exit 0; fi
  sleep 1; _i=$((_i + 1))
done
_bo=$(cat "$MW_STATE/backoff-until" 2>/dev/null)
case $_bo in ''|*[!0-9]*) _bo=0 ;; esac
if [ "$(now)" -lt "$_bo" ]; then
  debug "upload: backing off for $((_bo - $(now)))s"
  lock_release upload
  exit 0
fi
run_errors=0
errf=$MW_TMP/rclone-err.$$
list=$MW_TMP/list.$$
# shellcheck disable=SC2329  # called by trap
cleanup() { rm -f "$errf" "$list" "$list.sorted" "$MW_TMP/index.$$" "$MW_TMP/index-out.$$"; lock_release upload; }
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

# ---------------------------------------------------------- housekeeping ----

cap_queue() {
  _max_kb=$((QUEUE_MAX_MB * 1024))
  _n=$(queue_count)
  _kb=$(du -sk "$MW_QUEUE" 2>/dev/null | awk '{print $1}')
  case $_kb in ''|*[!0-9]*) _kb=0 ;; esac
  if [ "$_n" -le "$QUEUE_MAX_FILES" ] && [ "$_kb" -le "$_max_kb" ]; then
    return 0
  fi
  # File names start with YYYYMMDD-HHMMSS, so sorting by base name = oldest first.
  queue_files | awk -F/ '{print $NF "\t" $0}' | sort | cut -f2- > "$list.sorted"
  _del=0
  while IFS= read -r _f; do
    if [ "$_n" -le "$QUEUE_MAX_FILES" ] && [ "$_kb" -le "$_max_kb" ]; then break; fi
    _s=$(file_size "$_f")
    rm -f "$_f"
    _n=$((_n - 1)); _del=$((_del + 1))
    _kb=$((_kb - (${_s:-0} + 1023) / 1024))
  done < "$list.sorted"
  rm -f "$list.sorted"
  find "$MW_QUEUE" -mindepth 2 -type d -empty -exec rmdir {} \; 2>/dev/null
  log WARN "queue over cap (max $QUEUE_MAX_FILES files / $QUEUE_MAX_MB MB): deleted $_del oldest file(s) that were never uploaded"
}

cap_queue
find "$MW_TMP" -type f -mmin +360 -exec rm -f {} \; 2>/dev/null

# ---------------------------------------------------------------- online ----

prev_online=$(cat "$MW_STATE/online" 2>/dev/null)
force_flush=$now_mode
if is_online; then
  echo yes > "$MW_STATE/online"
  if [ "$prev_online" = no ]; then
    log INFO "back online (queue: $(queue_count) file(s)); uploading the backlog now"
    force_flush=1
  fi
else
  echo no > "$MW_STATE/online"
  [ "$prev_online" = no ] || log INFO "offline; shots will queue locally (queue: $(queue_count) file(s))"
  exit 0
fi

paused_remote && exit 0

# ---------------------------------------------------------- rclone errors ---

report_rclone_error() { # CONTEXT EXITCODE   (stderr of the failed call is in $errf)
  run_errors=$((run_errors + 1))
  _msg=$(tail -n 5 "$errf" 2>/dev/null | redact | tr '\n' ' ')
  _hint=
  case $_msg in
    *unauthorized*|*bad_auth_token*|*401*|*"didn't find section"*|*"couldn't find"*|*bad_request*"application key"*)
      _hint=" >>> AUTH PROBLEM: run ./bin/setup-remote.sh on the Mac (the Mac's B2 key)" ;;
    *cap_exceeded*|*"transaction cap"*|*"Transaction cap"*)
      echo $(($(now) + 3600)) > "$MW_STATE/backoff-until"
      _hint=" >>> Backblaze daily cap reached (pausing 1 h). See Backblaze > Caps & Alerts" ;;
    *429*|*too_many_requests*|*503*|*service_unavailable*|*"rate limit"*)
      echo $(($(now) + 300)) > "$MW_STATE/backoff-until"
      _hint=" >>> Backblaze asked us to slow down (pausing 5 min)" ;;
  esac
  note_error upload "$1 failed (exit $2): $_msg$_hint"
}

# ------------------------------------------------------------------ flush ---
# One rclone call for all three kinds: every rclone start authorizes with B2 once (a
# class C transaction, 2,500 free per day), so fewer calls = more headroom.
# --no-check-dest: do not list the bucket first (more class C calls, and nothing is ever
# uploaded twice). `move` deletes the local file only after a verified upload.

flush_queue() { # force(0/1)
  if [ "$1" != 1 ]; then
    _last=$(cat "$MW_STATE/last-flush" 2>/dev/null)
    case $_last in ''|*[!0-9]*) _last=0 ;; esac
    [ $(($(now) - _last)) -ge "$UPLOAD_EVERY_SEC" ] || return 0
  fi
  ( cd "$MW_QUEUE" 2>/dev/null && find shots thumbs recordings -type f \( -name '*.jpg' -o -name '*.mov' \) 2>/dev/null ) | sort > "$list"
  [ -s "$list" ] || return 0
  now > "$MW_STATE/last-flush"
  # sizes now: after the move the local files are gone
  while IFS= read -r _rel; do
    printf '%s %s\n' "$_rel" "$(file_size "$MW_QUEUE/$_rel")"
  done < "$list" > "$list.sorted"
  # Files are moved into queue/ atomically (mv), so they are always complete; --now uses no
  # minimum age, batches keep the plan's 15 s as a second safety margin.
  if [ "$now_mode" = 1 ]; then _age=0s; else _age=15s; fi
  rc move "$MW_QUEUE" "$(rpath '')" --min-age "$_age" --no-check-dest \
     --include '/shots/**' --include '/thumbs/**' --include '/recordings/**' --delete-empty-src-dirs 2> "$errf"
  _rc=$?
  mkdir -p "$MW_QUEUE"   # --delete-empty-src-dirs must never take the queue root
  _sent=0
  while IFS=' ' read -r _rel _size; do
    if [ ! -e "$MW_QUEUE/$_rel" ]; then
      printf '%s %s\n' "$_rel" "$_size" >> "$MW_STATE/index-pending"
      _sent=$((_sent + 1))
    fi
  done < "$list.sorted"
  rm -f "$list.sorted"
  if [ "$_rc" -ne 0 ]; then
    report_rclone_error "uploading" "$_rc"
  fi
  if [ "$_sent" -gt 0 ]; then
    now > "$MW_STATE/last-upload-ok"
    log INFO "upload ok: $_sent file(s) sent, $(queue_count) left in the queue"
  fi
}

# Tell the Worker what arrived. Kept in state/index-pending until the Worker confirms,
# so nothing is lost while it is unreachable.
send_index() {
  [ -s "$MW_STATE/index-pending" ] || return 0
  api_configured || return 0
  mv "$MW_STATE/index-pending" "$MW_TMP/index.$$"
  if api POST /mac/index "$MW_TMP/index-out.$$" "$MW_TMP/index.$$"; then
    debug "index: $(cat "$MW_TMP/index-out.$$")"
  else
    cat "$MW_TMP/index.$$" >> "$MW_STATE/index-pending"
    log WARN "could not tell the Worker about $(wc -l < "$MW_TMP/index.$$" | tr -d ' ') uploaded file(s): $(api_problem "$API_CODE") (will retry)"
  fi
  rm -f "$MW_TMP/index.$$"
}

flush_queue "$force_flush"
send_index

# A run with no rclone errors at all means B2 is healthy again.
[ "$run_errors" = 0 ] && clear_error upload
exit 0
