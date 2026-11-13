#!/bin/sh
# status.sh - what is mac-watch doing right now? Safe to run any time; changes nothing.
MW_BIN=$(cd "$(dirname "$0")" && pwd)
. "$MW_BIN/lib.sh"
MW_NAME=status
mw_load_config

t=$(now)
ago() { # EPOCH
  case $1 in ''|*[!0-9]*) printf 'never'; return ;; esac
  printf '%s ago' "$(age_str $((t - $1)))"
}
line() { printf '  %-14s %s\n' "$1" "$2"; }

echo "mac-watch status  ($(date '+%Y-%m-%d %H:%M:%S'))"
echo

if paused; then
  line "state" "PAUSED  (PAUSE file exists; nothing captures, records or uploads. Remove it with: rm $MW_PAUSE)"
else
  line "state" "active"
fi
line "lid" "$(lid_state)"

if command -v launchctl >/dev/null 2>&1 && [ "$(uname -s)" = Darwin ]; then
  for a in capture upload record; do
    if launchctl list 2>/dev/null | grep -q "com.macwatch.$a\$"; then
      line "agent $a" "loaded"
    else
      line "agent $a" "NOT loaded  (run ./bin/install.sh)"
    fi
  done
fi

lc=$(cat "$MW_STATE/last-capture" 2>/dev/null)
if [ -n "$lc" ]; then
  e=${lc%%|*}; rest=${lc#*|}; reason=${rest%%|*}; rest=${rest#*|}; fname=${rest%%|*}; res=${rest#*|}
  line "last capture" "$(ago "$e")  [$reason] $res $fname"
else
  line "last capture" "never"
fi

n=$(queue_count)
kb=$(du -sk "$MW_QUEUE" 2>/dev/null | awk '{print $1}')
line "queue" "$n file(s), ${kb:-0} KB waiting to upload (cap $QUEUE_MAX_FILES files / $QUEUE_MAX_MB MB)"
line "online" "$(cat "$MW_STATE/online" 2>/dev/null || echo unknown)  (as of the last upload run)"
line "last upload" "$(ago "$(cat "$MW_STATE/last-upload-ok" 2>/dev/null)")  (last time files really reached Drive)"
line "last poll" "$(ago "$(cat "$MW_STATE/last-poll" 2>/dev/null)")  (last time Drive was checked for markers)"

lr=$(cat "$MW_STATE/last-record" 2>/dev/null)
if [ -d "$MW_STATE/record.lock" ]; then
  line "recording" "IN PROGRESS"
elif [ -n "$lr" ]; then
  line "recording" "last finished $(ago "${lr%%|*}")"
else
  line "recording" "none yet"
fi

echo
errs=0
for f in "$MW_STATE"/error-*; do
  [ -f "$f" ] || continue
  errs=1
  c=${f##*/error-}
  e=$(cut -d' ' -f1 < "$f")
  m=$(cut -d' ' -f2- < "$f")
  line "ERROR $c" "$(ago "$e"): $m"
done
[ "$errs" = 0 ] && line "errors" "none"

echo
echo "  last log lines (log/):"
for l in capture upload record events; do
  [ -s "$MW_LOG/$l.log" ] && tail -n 2 "$MW_LOG/$l.log" | sed "s/^/    $l: /"
done
exit 0
