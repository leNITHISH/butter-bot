#!/bin/sh
# capture.sh <reason> - one screenshot -> tmp/ -> queue/shots/YYYY-MM-DD/.
# Called by trigger.sh, which has already done the gate and the debounce.
# File name: YYYYMMDD-HHMMSS-<reason>.jpg
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
mw_init capture

reason=${1:-manual}
ts=$(date +%Y%m%d-%H%M%S)
day=$(date +%Y-%m-%d)
name=$ts-$reason.jpg
raw=$MW_TMP/$name.raw.$$
fin=$MW_TMP/$name.$$
tiny=$MW_TMP/$name.tiny.$$
errf=$MW_TMP/$name.err.$$
# shellcheck disable=SC2329  # called by trap
cleanup() { rm -f "$raw" "$fin" "$tiny" "$errf"; }
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

stamp() { printf '%s|%s|%s|%s\n' "$(now)" "$reason" "$1" "$2" > "$MW_STATE/last-capture"; }

# 1. Capture. Without Screen Recording permission screencapture still exits 0
#    but only shows wallpaper, so a clean exit proves nothing; selftest asks a human.
# shellcheck disable=SC2086  # SCREENCAPTURE_EXTRA is meant to word-split
screencapture -x -t jpg $SCREENCAPTURE_EXTRA "$raw" 2> "$errf"
if [ ! -s "$raw" ]; then
  note_error capture "screencapture produced no image (display asleep, no Screen Recording permission, or lid closed): $(head -c 200 "$errf" 2>/dev/null | tr '\n' ' ')"
  stamp - failed
  exit 1
fi

# 2. Shrink and compress. Never enlarge small screens.
width=$(sips -g pixelWidth "$raw" 2>/dev/null | awk '/pixelWidth/ {print $2}')
case $width in ''|*[!0-9]*) width=0 ;; esac
if [ "$width" -gt "$MAX_WIDTH" ]; then
  sips --resampleWidth "$MAX_WIDTH" -s format jpeg -s formatOptions "$JPEG_QUALITY" "$raw" --out "$fin" >/dev/null 2>&1
else
  sips -s format jpeg -s formatOptions "$JPEG_QUALITY" "$raw" --out "$fin" >/dev/null 2>&1
fi
if [ ! -s "$fin" ]; then
  log WARN "sips failed, keeping the uncompressed capture"
  cp "$raw" "$fin"
fi

# 3. Phase 4: hash a 16x16 copy of every kept shot. On the periodic shot only,
#    skip it when the screen matches the previous kept shot. Always keep at
#    least one shot per SKIP_MAX_AGE_SEC so silence never looks like a dead Mac.
h=
if [ "$SKIP_IDENTICAL" = 1 ]; then
  sips -z 16 16 -s format bmp "$fin" --out "$tiny" >/dev/null 2>&1
  [ -s "$tiny" ] && h=$(cksum < "$tiny" | awk '{print $1 "-" $2}')
fi
if [ -n "$h" ] && [ "$reason" = interval ]; then
  prev=$(cat "$MW_STATE/last-hash" 2>/dev/null)
  keep_t=$(cat "$MW_STATE/last-keep" 2>/dev/null)
  case $keep_t in ''|*[!0-9]*) keep_t=0 ;; esac
  if [ "$h" = "$prev" ] && [ $(($(now) - keep_t)) -lt "$SKIP_MAX_AGE_SEC" ]; then
    log INFO "skipped $name: screen unchanged"
    stamp - skipped-identical
    clear_error capture
    exit 0
  fi
fi

# 4. Publish atomically: same filesystem, so mv is a rename and the uploader
#    never sees a half-written file.
mkdir -p "$MW_QUEUE/shots/$day"
# two shots with the same reason in the same second must not overwrite each other
n=1
while [ -e "$MW_QUEUE/shots/$day/$name" ]; do
  n=$((n + 1))
  name=$ts-$reason-$n.jpg
done
if ! mv "$fin" "$MW_QUEUE/shots/$day/$name"; then
  note_error capture "could not move $name into the queue"
  exit 1
fi
now > "$MW_STATE/last-keep"
[ -n "$h" ] && echo "$h" > "$MW_STATE/last-hash"
stamp "$name" ok
clear_error capture
log INFO "captured $name ($(file_size "$MW_QUEUE/shots/$day/$name") bytes)"
exit 0
