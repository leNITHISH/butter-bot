#!/bin/sh
# lib.sh - shared helpers for mac-watch. Source it; do not run it.
#
# Every script starts with:
#     MW_BIN=$(cd "$(dirname "$0")" && pwd)
#     . "$MW_BIN/lib.sh"
#     mw_init <lognamename>
#
# POSIX sh only. No bashisms, no GNU-only flags (macOS has bash 3.2 and BSD tools).
# shellcheck disable=SC2034  # config variables are used by the scripts that source us

: "${MW_BIN:?lib.sh: MW_BIN must be set by the caller}"

# MW_HOME holds config.env and the runtime data. It defaults to the repo root,
# the tests point it at a scratch directory.
MW_HOME=${MW_HOME:-$(dirname "$MW_BIN")}
MW_QUEUE=$MW_HOME/queue
MW_TMP=$MW_HOME/tmp
MW_LOG=$MW_HOME/log
MW_STATE=$MW_HOME/state
MW_PAUSE=$MW_HOME/PAUSE
export MW_BIN MW_HOME

# launchd gives jobs a bare PATH. Homebrew goes last so test stubs and the
# user's own PATH win.
PATH=$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

MW_CONNECT_URL=${MW_CONNECT_URL:-https://connectivitycheck.gstatic.com/generate_204}

# ---------------------------------------------------------------- config ----

mw_defaults() {
  INTERVAL_SEC=300
  MAX_WIDTH=1440
  JPEG_QUALITY=60
  SCREENCAPTURE_EXTRA=""
  SKIP_IDENTICAL=1
  SKIP_MAX_AGE_SEC=3600
  RCLONE_REMOTE=gdrive
  DRIVE_FOLDER=mac-watch
  RETENTION_DAYS=14
  QUEUE_MAX_FILES=2000
  QUEUE_MAX_MB=2000
  KEEP_AWAKE=0
  CONTROL_POLL_SEC=60
  MARKER_MAX_AGE_MIN=30
  RECORD_SEC=300
  RECORD_PRESET=Preset1280x720
  SPACE_MIN_GAP_SEC=30
  EVENT_MIN_GAP_SEC=30
  # Internal knobs (not in config.env; the tests override them via the environment)
  UPLOAD_EVERY_SEC=${UPLOAD_EVERY_SEC:-300}
  PRUNE_EVERY_SEC=${PRUNE_EVERY_SEC:-3600}
  SETTLE_SEC=${SETTLE_SEC:-16}            # wait for rclone --min-age 15s after a remote snap
  WATCHDOG_POLL_SEC=${WATCHDOG_POLL_SEC:-2}
  STOP_GRACE_SEC=${STOP_GRACE_SEC:-5}
}

# Replace a non-numeric value with a default so a typo in config.env cannot
# turn into a shell error or an endless loop.
_int_or() { # NAME DEFAULT
  eval "_v=\${$1:-}"
  # shellcheck disable=SC2154  # _v is set by the eval above
  case $_v in
    ''|*[!0-9]*) eval "$1=$2" ;;
  esac
}

mw_load_config() {
  mw_defaults
  if [ -r "$MW_HOME/config.env" ]; then
    # shellcheck source=/dev/null
    . "$MW_HOME/config.env"
  fi
  # Settings changed from the web page: written only by apply_remote_config
  # (strictly validated KEY=number lines), so sourcing it is safe.
  if [ -r "$MW_STATE/remote.conf" ]; then
    # shellcheck source=/dev/null
    . "$MW_STATE/remote.conf"
  fi
  _int_or INTERVAL_SEC 300
  _int_or MAX_WIDTH 1440
  _int_or JPEG_QUALITY 60
  _int_or SKIP_IDENTICAL 1
  _int_or SKIP_MAX_AGE_SEC 3600
  _int_or RETENTION_DAYS 14
  _int_or QUEUE_MAX_FILES 2000
  _int_or QUEUE_MAX_MB 2000
  _int_or KEEP_AWAKE 0
  _int_or CONTROL_POLL_SEC 60
  _int_or MARKER_MAX_AGE_MIN 30
  _int_or RECORD_SEC 300
  _int_or SPACE_MIN_GAP_SEC 30
  _int_or EVENT_MIN_GAP_SEC 30
  _int_or UPLOAD_EVERY_SEC 120
  _int_or PRUNE_EVERY_SEC 3600
  _int_or SETTLE_SEC 16
  _int_or WATCHDOG_POLL_SEC 2
  _int_or STOP_GRACE_SEC 5
  [ "$INTERVAL_SEC" -ge 10 ] || INTERVAL_SEC=300
  [ "$RECORD_SEC" -ge 5 ] || RECORD_SEC=300
}

# ---------------------------------------------------------------- logging ---

# Keep roughly 1 MB per log: copy to .1, truncate in place (launchd holds the
# launchd-*.log files open, so we must not move them).
rotate_log() { # FILE
  [ -f "$1" ] || return 0
  _sz=$(wc -c < "$1" 2>/dev/null | tr -d ' ')
  if [ "${_sz:-0}" -gt 1048576 ]; then
    cp "$1" "$1.1" 2>/dev/null
    : > "$1"
  fi
}

mw_init() { # LOGNAME
  MW_NAME=$1
  umask 077
  mw_load_config
  mkdir -p "$MW_QUEUE" "$MW_TMP" "$MW_LOG" "$MW_STATE" 2>/dev/null
  rotate_log "$MW_LOG/$MW_NAME.log"
  rotate_log "$MW_LOG/launchd-$MW_NAME.log"
}

log() { # LEVEL message...
  _lvl=$1; shift
  printf '%s %-5s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$_lvl" "$*" \
    >> "$MW_LOG/${MW_NAME:-misc}.log" 2>/dev/null
  return 0
}

debug() { [ "${MW_DEBUG:-0}" = 1 ] && log DEBUG "$*"; return 0; }

# Persistent per-component error flag shown by status.sh.
note_error() { # COMPONENT message...
  _c=$1; shift
  printf '%s %s\n' "$(date +%s)" "$*" > "$MW_STATE/error-$_c" 2>/dev/null
  log ERROR "$*"
}
clear_error() { rm -f "$MW_STATE/error-$1" 2>/dev/null; return 0; }

# Remove anything that looks like a token before it can reach a log.
redact() {
  sed -E 's/(access_token|refresh_token|client_secret|token|secret)(["'"'"' :=]+)[A-Za-z0-9._~+\/=-]{8,}/\1\2[redacted]/g'
}

# ---------------------------------------------------------------- time ------

now() { date +%s; }

# "YYYY-MM-DD HH:MM:SS" -> seconds, treating the wall clock as UTC. Only the
# difference between two such values means anything, which is all we need and
# keeps us independent of BSD vs GNU `date` parsing and of time zones.
wall_to_secs() {
  awk -v s="$1" 'BEGIN {
    n = split(s, a, /[- :T]+/)
    if (n < 6) { exit 1 }
    y = a[1] + 0; m = a[2] + 0; d = a[3] + 0
    if (m <= 2) y--
    era = int(y / 400); yoe = y - era * 400
    mp = (m > 2) ? m - 3 : m + 9
    doy = int((153 * mp + 2) / 5) + d - 1
    doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
    days = era * 146097 + doe - 719468
    printf "%.0f\n", days * 86400 + a[4] * 3600 + a[5] * 60 + a[6]
  }'
}

local_wall_now() { date '+%Y-%m-%d %H:%M:%S'; }

age_str() { # SECONDS -> 45s / 12m / 3h / 2d
  _s=$1
  [ "$_s" -lt 0 ] && _s=0
  if   [ "$_s" -lt 120 ];    then printf '%ss' "$_s"
  elif [ "$_s" -lt 7200 ];   then printf '%sm' $((_s / 60))
  elif [ "$_s" -lt 172800 ]; then printf '%sh' $((_s / 3600))
  else printf '%sd' $((_s / 86400))
  fi
}

# ---------------------------------------------------------------- the gate --

# Two kinds of pause. PAUSE (a file you create on the Mac) stops EVERYTHING,
# including talking to Drive. A remote pause (set from the phone/web page with a
# `pause` marker, lifted with `resume`) stops capture, recording and uploads but
# keeps polling Drive so that `resume` can reach us.
paused_local() { [ -e "$MW_PAUSE" ]; }
paused_remote() { [ -e "$MW_STATE/remote-paused" ]; }
paused() { paused_local || paused_remote; }

# Prints open | closed | unknown.
lid_state() {
  _l=$(ioreg -r -k AppleClamshellState -d 4 2>/dev/null | grep '"AppleClamshellState"' | head -n 1)
  case $_l in
    *"= Yes"*) echo closed ;;
    *"= No"*)  echo open ;;
    *)         echo unknown ;;
  esac
}

# Open (or unknown, logged once) -> 0. Closed -> 1.
lid_open() {
  case $(lid_state) in
    closed) return 1 ;;
    unknown)
      if [ ! -e "$MW_STATE/lid-key-missing" ]; then
        : > "$MW_STATE/lid-key-missing" 2>/dev/null
        log WARN "AppleClamshellState not found in ioreg; treating the lid as open (logged once)"
      fi
      return 0 ;;
    *) return 0 ;;
  esac
}

# THE gate. Everything that captures, records or uploads goes through here.
gate() { # [quiet]
  if paused_local; then
    [ "${1:-}" = quiet ] || log INFO "skip: PAUSE file present"
    return 1
  fi
  if paused_remote; then
    [ "${1:-}" = quiet ] || log INFO "skip: paused remotely (send a resume marker)"
    return 1
  fi
  if ! lid_open; then
    [ "${1:-}" = quiet ] || log INFO "skip: lid closed"
    return 1
  fi
  return 0
}

# ------------------------------------------------------- remote settings -----
# Which settings may be changed from the web page, and the allowed range.
# Anything else (Drive folder, rclone remote, extra screencapture flags, queue
# caps, poll interval) can only be changed in config.env on the Mac. There is
# deliberately no way to put text into a setting: numbers only.
# NOTE: web/logic.js has the same table; tests/run.sh checks they match.
remote_bounds() { # KEY -> "min max"
  case $1 in
    INTERVAL_SEC)        echo "30 86400" ;;
    MAX_WIDTH)           echo "320 4000" ;;
    JPEG_QUALITY)        echo "10 100" ;;
    SKIP_IDENTICAL)      echo "0 1" ;;
    SKIP_MAX_AGE_SEC)    echo "60 86400" ;;
    RETENTION_DAYS)      echo "3 365" ;;
    KEEP_AWAKE)          echo "0 1" ;;
    RECORD_SEC)          echo "10 1800" ;;
    SPACE_MIN_GAP_SEC)   echo "5 3600" ;;
    EVENT_MIN_GAP_SEC)   echo "5 3600" ;;
    UPLOAD_EVERY_SEC)    echo "0 3600" ;;
    MARKER_MAX_AGE_MIN)  echo "1 1440" ;;
  esac
}
remote_keys() { echo "INTERVAL_SEC MAX_WIDTH JPEG_QUALITY SKIP_IDENTICAL SKIP_MAX_AGE_SEC RETENTION_DAYS KEEP_AWAKE RECORD_SEC SPACE_MIN_GAP_SEC EVENT_MIN_GAP_SEC UPLOAD_EVERY_SEC MARKER_MAX_AGE_MIN"; }

# apply_remote_config SRC DST: keep only valid, in-range whitelisted KEY=number
# lines. Prints "applied=N rejected=M".
apply_remote_config() {
  _n=0; _bad=0
  : > "$2.new"
  while IFS= read -r _l || [ -n "$_l" ]; do
    _l=$(printf '%s' "$_l" | tr -d '\r')
    case $_l in ''|'#'*) continue ;; esac
    _k=${_l%%=*}; _v=${_l#*=}
    case $_k in ''|*[!A-Z_]*) _bad=$((_bad + 1)); continue ;; esac
    case $_v in ''|*[!0-9]*) _bad=$((_bad + 1)); continue ;; esac
    _v=$(printf '%s' "$_v" | sed 's/^0*\([0-9]\)/\1/')     # no leading zeros (octal trap)
    _b=$(remote_bounds "$_k")
    if [ -z "$_b" ] || [ "${#_v}" -gt 7 ] || [ "$_v" -lt "${_b% *}" ] || [ "$_v" -gt "${_b#* }" ]; then
      _bad=$((_bad + 1)); continue
    fi
    printf '%s=%s\n' "$_k" "$_v" >> "$2.new"
    _n=$((_n + 1))
  done < "$1"
  mv "$2.new" "$2"
  echo "applied=$_n rejected=$_bad"
}

# ---------------------------------------------------------------- locks -----

# mkdir is atomic. A lock is stale when its owner pid is dead or it is older
# than STALE_MIN minutes.
lock_acquire() { # NAME STALE_MIN
  _d=$MW_STATE/$1.lock
  if mkdir "$_d" 2>/dev/null; then
    echo $$ > "$_d/pid"
    return 0
  fi
  _stale=0
  _p=$(cat "$_d/pid" 2>/dev/null)
  if [ -n "$_p" ] && ! kill -0 "$_p" 2>/dev/null; then
    _stale=1
  elif [ -n "$(find "$_d" -prune -mmin +"$2" 2>/dev/null)" ]; then
    _stale=1
  fi
  if [ "$_stale" = 1 ]; then
    log WARN "removing stale lock $1 (owner pid ${_p:-?})"
    rm -rf "$_d"
    if mkdir "$_d" 2>/dev/null; then
      echo $$ > "$_d/pid"
      return 0
    fi
  fi
  return 1
}

lock_release() { rm -rf "$MW_STATE/$1.lock"; }

# ---------------------------------------------------------------- network ---

is_online() {
  _code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$MW_CONNECT_URL" 2>/dev/null)
  [ "$_code" = 204 ]
}

# rclone with sane timeouts so a dead network cannot hang a job. Errors only.
rc() { rclone -q --contimeout 15s --timeout 60s --retries 2 --low-level-retries 3 "$@"; }

rpath() { # SUBPATH -> remote:folder/subpath
  printf '%s:%s/%s' "$RCLONE_REMOTE" "$DRIVE_FOLDER" "$1"
}

# ---------------------------------------------------------------- misc ------

file_size() { wc -c < "$1" 2>/dev/null | tr -d ' '; }

# Debounce window for a trigger reason, in seconds.
min_gap_for() {
  case $1 in
    space)                    echo "$SPACE_MIN_GAP_SEC" ;;
    interval)                 echo $((INTERVAL_SEC - 10)) ;;   # the agent ticks every CONTROL_POLL_SEC
    remote)                   echo 20 ;;
    wake|lock|unlock|login)   echo "$EVENT_MIN_GAP_SEC" ;;
    *)                        echo 0 ;;
  esac
}

# Count / list the files waiting to upload (shots, recordings, control notes).
queue_files() {
  find "$MW_QUEUE" -type f \( -name '*.jpg' -o -name '*.mov' -o -name '*.txt' \) 2>/dev/null
}
queue_count() { queue_files | wc -l | tr -d ' '; }
