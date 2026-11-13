#!/bin/sh
# upload.sh - runs every CONTROL_POLL_SEC (and when the network config changes).
#   1. gate (lid open, no PAUSE); optional KEEP_AWAKE
#   2. housekeeping: queue cap, old temp files          (also works while offline)
#   3. online check; exit quietly when offline
#   4. Drive control/ markers: snap-now, record-5min
#   5. flush queue/ to Drive (rclone move), prune Drive older than RETENTION_DAYS
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
mw_init upload

gate quiet || exit 0

# ------------------------------------------------------------ keep awake ----
# Optional (KEEP_AWAKE=1). Each poll starts a short caffeinate that expires on
# its own, so closing the lid (which stops this job) releases the hold within
# a few minutes. Needs AbandonProcessGroup in the plist so launchd leaves it be.
keepawake_tick() {
  [ "$KEEP_AWAKE" = 1 ] || return 0
  command -v caffeinate >/dev/null 2>&1 || return 0
  caffeinate -di -t $((CONTROL_POLL_SEC * 3)) >/dev/null 2>&1 &
}
keepawake_tick

"$MW_BIN/heartbeat.sh" power

if ! lock_acquire upload 10; then
  debug "upload: previous run still going"
  exit 0
fi
errf=$MW_TMP/rclone-err.$$
list=$MW_TMP/list.$$
# shellcheck disable=SC2329  # called by trap
cleanup() { rm -f "$errf" "$list" "$list.sorted"; lock_release upload; }
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
if is_online; then
  echo yes > "$MW_STATE/online"
  [ "$prev_online" = no ] && log INFO "back online (queue: $(queue_count) file(s))"
else
  echo no > "$MW_STATE/online"
  [ "$prev_online" = no ] || log INFO "offline; shots will queue locally (queue: $(queue_count) file(s))"
  exit 0
fi
now > "$MW_STATE/last-poll"

# ---------------------------------------------------------- rclone errors ---

report_rclone_error() { # CONTEXT EXITCODE   (stderr of the failed call is in $errf)
  _msg=$(tail -n 5 "$errf" 2>/dev/null | redact | tr '\n' ' ')
  _hint=
  case $_msg in
    *invalid_grant*|*oauth2*|*401*|*nauthorized*|*"didn't find section"*|*authError*|*"refresh token"*|*"Failed to configure token"*)
      _hint=" >>> AUTH PROBLEM: on the Mac run: rclone config reconnect $RCLONE_REMOTE:" ;;
    *rateLimitExceeded*|*"User rate limit"*)
      _hint=" >>> Drive rate limit: see README 'Rate limits' (own OAuth client)" ;;
  esac
  note_error upload "$1 failed (exit $2): $_msg$_hint"
}

# ---------------------------------------------------------------- markers ---
# A marker is any file OR folder in Drive control/ whose name starts with
# snap-now or record-5min (any case). Delete first, act only if the delete worked.

want_settle=0

handle_markers() {
  _ctl=$(rpath control)
  rc lsf --format tp "$_ctl" > "$list" 2> "$errf"
  _st=$?
  if [ "$_st" -eq 3 ]; then
    rc mkdir "$_ctl" 2> "$errf" || report_rclone_error "creating control folder" $?
    return 0
  fi
  if [ "$_st" -ne 0 ]; then
    report_rclone_error "listing control/" "$_st"
    return 0
  fi
  _now_w=$(wall_to_secs "$(local_wall_now)")

  while IFS= read -r _line <&3; do
    [ -n "$_line" ] || continue
    _t=${_line%%;*}
    _p=${_line#*;}
    _isdir=0
    case $_p in */) _isdir=1; _p=${_p%/} ;; esac
    _lc=$(printf '%s' "$_p" | tr '[:upper:]' '[:lower:]')
    case $_lc in
      snap-now*)    _kind=snap ;;
      record-5min*) _kind=record ;;
      *)            continue ;;
    esac

    _mt=$(wall_to_secs "$_t")
    if [ -n "$_mt" ]; then
      _age=$((_now_w - _mt))
    else
      _age=0
      log WARN "marker '$_p': cannot read its time ('$_t'), treating it as fresh"
    fi

    # delete first
    if [ "$_isdir" = 1 ]; then
      rc purge "$_ctl/$_p" --drive-use-trash=false 2> "$errf"
    else
      rc deletefile "$_ctl/$_p" --drive-use-trash=false 2> "$errf"
    fi
    _drc=$?
    if [ "$_drc" -ne 0 ]; then
      report_rclone_error "deleting marker '$_p' (not acting on it)" "$_drc"
      continue
    fi

    if [ "$_age" -gt $((MARKER_MAX_AGE_MIN * 60)) ]; then
      log INFO "marker '$_p' is $(age_str "$_age") old (limit ${MARKER_MAX_AGE_MIN}m): deleted, not acted on"
      continue
    fi

    case $_kind in
      snap)
        log INFO "marker '$_p': taking a screenshot"
        "$MW_BIN/trigger.sh" remote
        want_settle=1
        ;;
      record)
        log INFO "marker '$_p': starting a ${RECORD_SEC}s recording"
        start_recording "$_p"
        ;;
    esac
  done 3< "$list"   # fd 3: nothing inside the loop can eat our input
}

# Recordings run as their own on-demand LaunchAgent so they outlive this job
# and get normal signal handling. See bin/record.sh.
start_recording() { # MARKER-NAME
  if [ -d "$MW_STATE/record.lock" ]; then
    log INFO "marker '$1': a recording is already running, ignoring"
    return 0
  fi
  printf '%s' "$1" > "$MW_STATE/record-request"
  if ! launchctl kickstart "gui/$(id -u)/com.macwatch.record" > "$errf" 2>&1; then
    note_error record "could not start the recording agent (run ./bin/install.sh again?): $(head -c 200 "$errf" | tr '\n' ' ')"
    rm -f "$MW_STATE/record-request"
  fi
}

handle_markers

# ------------------------------------------------------------------ flush ---

flush_queue() { # force(0/1)
  if [ "$1" != 1 ]; then
    _last=$(cat "$MW_STATE/last-flush" 2>/dev/null)
    case $_last in ''|*[!0-9]*) _last=0 ;; esac
    [ $(($(now) - _last)) -ge "$UPLOAD_EVERY_SEC" ] || return 0
  fi
  [ "$(queue_count)" -gt 0 ] || return 0
  now > "$MW_STATE/last-flush"
  _before=$(queue_count)
  _failed=0
  for _kind in shots recordings control; do
    [ -d "$MW_QUEUE/$_kind" ] || continue
    # `move` deletes the local file only after a verified upload.
    rc move "$MW_QUEUE/$_kind" "$(rpath "$_kind")" --min-age 15s --delete-empty-src-dirs 2> "$errf"
    _rc=$?
    if [ "$_rc" -ne 0 ]; then
      report_rclone_error "uploading $_kind" "$_rc"
      _failed=1
    fi
  done
  mkdir -p "$MW_QUEUE"   # --delete-empty-src-dirs must never take the queue root
  if [ "$_failed" = 0 ]; then
    clear_error upload
    _sent=$((_before - $(queue_count)))
    if [ "$_sent" -gt 0 ]; then
      now > "$MW_STATE/last-upload-ok"
      log INFO "upload ok: $_sent of $_before file(s) uploaded, $(queue_count) left (newer than 15s)"
    fi
  fi
}

if [ "$want_settle" = 1 ]; then
  sleep "$SETTLE_SEC"   # rclone --min-age 15s would skip the shot we just took
  flush_queue 1
else
  flush_queue 0
fi

# ------------------------------------------------------------------ prune ---
# Permanent delete (no Trash, which would keep eating quota), then drop empty
# date folders. rclone exit 3 = directory does not exist yet: fine.

prune_drive() {
  _last=$(cat "$MW_STATE/last-prune" 2>/dev/null)
  case $_last in ''|*[!0-9]*) _last=0 ;; esac
  [ $(($(now) - _last)) -ge "$PRUNE_EVERY_SEC" ] || return 0
  now > "$MW_STATE/last-prune"
  for _kind in shots recordings; do
    rc delete "$(rpath "$_kind")" --min-age "${RETENTION_DAYS}d" --drive-use-trash=false 2> "$errf"
    _rc=$?
    if [ "$_rc" -ne 0 ] && [ "$_rc" -ne 3 ]; then report_rclone_error "pruning $_kind" "$_rc"; continue; fi
    rc rmdirs "$(rpath "$_kind")" --leave-root 2> "$errf"
    _rc=$?
    if [ "$_rc" -ne 0 ] && [ "$_rc" -ne 3 ]; then report_rclone_error "removing empty $_kind folders" "$_rc"; fi
  done
  # old "done-*" notes only; never touch anything else the user keeps in control/
  rc delete "$(rpath control)" --include 'done-*.txt' --min-age "${RETENTION_DAYS}d" --drive-use-trash=false 2> "$errf"
  _rc=$?
  if [ "$_rc" -ne 0 ] && [ "$_rc" -ne 3 ]; then report_rclone_error "pruning control notes" "$_rc"; fi
  log INFO "prune: removed Drive files older than ${RETENTION_DAYS}d"
}
prune_drive

exit 0
