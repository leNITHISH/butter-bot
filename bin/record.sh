#!/bin/sh
# record.sh [SECONDS] [MARKER]  - screen recording -> tmp/ -> queue/recordings/YYYY-MM-DD/
#   record.sh --request          launchd mode: reads the marker name left in
#                                state/record-request by upload.sh
# Screen only: no audio (-g not passed), no camera. macOS shows its own
# recording indicator and this script does not try to hide it.
#
# Why the recorder runs in the FOREGROUND and the watchdog in the background:
# a background job started from a non-interactive sh has SIGINT ignored, and
# screencapture only finalises the movie file on SIGINT/SIGTERM. Keeping it
# in the foreground keeps its signals normal.
MW_BIN=$(cd "$(dirname "$0")" && pwd)
. "$MW_BIN/lib.sh"
mw_init record

marker=${2:-}
if [ "${1:-}" = "--request" ]; then
  secs=$RECORD_SEC
  marker=$(cat "$MW_STATE/record-request" 2>/dev/null)
  rm -f "$MW_STATE/record-request"
else
  secs=${1:-$RECORD_SEC}
fi
case $secs in ''|*[!0-9]*) log ERROR "record: bad seconds '$secs'"; exit 2 ;; esac
[ "$secs" -ge 3 ] || secs=3

gate || exit 0

# Only one recording at a time. Stale after the recording could have finished
# plus 10 minutes of compression.
if ! lock_acquire record $((secs / 60 + 10)); then
  log INFO "record: another recording is already running, not starting a second"
  exit 0
fi

ts=$(date +%Y%m%d-%H%M%S)
day=$(date +%Y-%m-%d)
name=$ts-rec.mov
raw=$MW_TMP/$name.raw.$$.mov
out=$MW_TMP/$name.out.$$.mov
pidf=$MW_TMP/$name.pid.$$
errf=$MW_TMP/$name.err.$$
flagf=$MW_TMP/$name.stopped.$$
wd=
# shellcheck disable=SC2329  # called by trap
cleanup() {
  [ -n "$wd" ] && kill "$wd" 2>/dev/null
  rm -f "$raw" "$out" "$pidf" "$errf" "$flagf"
  lock_release record
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

log INFO "record: starting ${secs}s recording${marker:+ (marker $marker)}"

# Watchdog (background): ends the recording early when the lid closes or PAUSE
# appears, and enforces a wall-clock limit in case screencapture overruns.
# INT first (clean finish), then TERM, then KILL.
(
  i=0
  while [ ! -s "$pidf" ] && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
  pid=$(cat "$pidf" 2>/dev/null)
  [ -n "$pid" ] || exit 0
  deadline=$(( $(now) + secs + 30 ))
  while kill -0 "$pid" 2>/dev/null; do
    why=
    if ! gate quiet; then why="lid closed or PAUSE"; fi
    if [ -z "$why" ] && [ "$(now)" -ge "$deadline" ]; then why="time limit"; fi
    if [ -n "$why" ]; then
      echo "$why" > "$flagf"
      kill -INT "$pid" 2>/dev/null
      sleep "$STOP_GRACE_SEC"
      kill -0 "$pid" 2>/dev/null && kill -TERM "$pid" 2>/dev/null
      sleep "$STOP_GRACE_SEC"
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
      exit 0
    fi
    sleep "$WATCHDOG_POLL_SEC"
  done
) &
wd=$!

# Recorder (foreground). The inner sh writes its pid, then becomes screencapture.
# shellcheck disable=SC2086  # SCREENCAPTURE_EXTRA is meant to word-split
sh -c 'echo $$ > "$1"; shift; exec "$@"' sh "$pidf" \
  screencapture -v -V "$secs" -x $SCREENCAPTURE_EXTRA "$raw" 2> "$errf"
rrc=$?
kill "$wd" 2>/dev/null
wait "$wd" 2>/dev/null
wd=

partial=no
if [ -s "$flagf" ]; then
  partial="yes ($(cat "$flagf"))"
  log WARN "record: stopped early: $(cat "$flagf"); keeping the partial file"
fi

if [ ! -s "$raw" ]; then
  note_error record "screencapture -v produced no file (exit $rrc, Screen Recording permission?): $(head -c 200 "$errf" 2>/dev/null | tr '\n' ' ')"
  exit 1
fi

# Compress: avconvert (built in) -> ffmpeg (if installed) -> keep the original.
final=$raw
if command -v avconvert >/dev/null 2>&1 &&
   avconvert --preset "$RECORD_PRESET" --source "$raw" --output "$out" >/dev/null 2>&1 &&
   [ -s "$out" ]; then
  final=$out
  log INFO "record: compressed with avconvert ($RECORD_PRESET)"
else
  rm -f "$out"
  if command -v ffmpeg >/dev/null 2>&1 &&
     ffmpeg -y -loglevel error -i "$raw" -vf scale=-2:720 -c:v libx264 -crf 30 -preset veryfast -an "$out" >/dev/null 2>&1 &&
     [ -s "$out" ]; then
    final=$out
    log INFO "record: compressed with ffmpeg"
  else
    rm -f "$out"
    log WARN "record: no compression available or it failed; keeping the original"
  fi
fi
# Never keep a "compressed" file that is bigger than the original.
if [ "$final" = "$out" ] && [ "$(file_size "$out")" -ge "$(file_size "$raw")" ]; then
  final=$raw
fi

mkdir -p "$MW_QUEUE/recordings/$day"
if ! mv "$final" "$MW_QUEUE/recordings/$day/$name"; then
  note_error record "could not move $name into the queue"
  exit 1
fi
size=$(file_size "$MW_QUEUE/recordings/$day/$name")
clear_error record
printf '%s|%s|%s|%s\n' "$(now)" record "$name" ok > "$MW_STATE/last-record"
log INFO "record: queued $name ($size bytes, partial: $partial)"

# Tell the phone user it ran: a tiny note that uploads to control/.
if [ -n "$marker" ]; then
  safe=$(printf '%s' "$marker" | tr -c 'A-Za-z0-9._-' '_')
  note=done-$safe-$(date +%H%M%S).txt
  mkdir -p "$MW_QUEUE/control"
  {
    echo "marker:    $marker"
    echo "finished:  $(date '+%Y-%m-%d %H:%M:%S')"
    echo "recording: recordings/$day/$name"
    echo "size:      $size bytes"
    echo "partial:   $partial"
  } > "$MW_TMP/$note.$$"
  mv "$MW_TMP/$note.$$" "$MW_QUEUE/control/$note"
fi
exit 0
