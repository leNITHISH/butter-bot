#!/bin/sh
# status.sh - what is mac-watch doing right now? Safe to run any time; changes nothing.
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
mw_load_config

t=$(now)
ago() { # EPOCH
  case $1 in ''|*[!0-9]*) printf 'never'; return ;; esac
  printf '%s ago' "$(age_str $((t - $1)))"
}
line() { printf '  %-14s %s\n' "$1" "$2"; }

echo "mac-watch status  ($(date '+%Y-%m-%d %H:%M:%S'))"
echo

if paused_local; then
  line "state" "PAUSED  (PAUSE file exists; nothing captures, records or uploads. Remove it with: rm $MW_PAUSE)"
elif paused_remote; then
  line "state" "PAUSED REMOTELY  (from the web page; press Resume there, or: rm $MW_STATE/remote-paused)"
else
  line "state" "active"
fi
if [ -s "$MW_STATE/remote.conf" ]; then
  line "remote cfg" "$(grep -c . "$MW_STATE/remote.conf") setting(s) from the web page override config.env: $(tr '\n' ' ' < "$MW_STATE/remote.conf")"
fi
if [ -e "$MW_STATE/hammerspoon-enabled" ]; then
  if pgrep -x Hammerspoon >/dev/null 2>&1; then line "hammerspoon" "running"; else line "hammerspoon" "NOT running (mac-watch will start it within a minute)"; fi
fi
line "lid" "$(lid_state)"

if command -v launchctl >/dev/null 2>&1 && [ "$(uname -s)" = Darwin ]; then
  for a in capture upload listen record hammerspoon; do
    [ "$a" = hammerspoon ] && [ ! -e "$MW_STATE/hammerspoon-enabled" ] && continue
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
line "last upload" "$(ago "$(cat "$MW_STATE/last-upload-ok" 2>/dev/null)")  (last time files really reached Backblaze)"
pend=$(grep -c . "$MW_STATE/index-pending" 2>/dev/null)
[ "${pend:-0}" -gt 0 ] && line "index" "$pend uploaded file(s) not yet reported to the Worker (retried every minute)"
if [ ! -s "$MW_HOME/.mac-token" ]; then
  line "worker" "NOT SET UP  (run ./bin/setup-remote.sh)"
else
  case $(cat "$MW_STATE/worker-reach" 2>/dev/null) in
    ok)        wr="reachable" ;;
    "fail 000") wr="NOT reachable (offline?)" ;;
    fail*)     wr="REFUSING this Mac (HTTP $(cut -d' ' -f2 "$MW_STATE/worker-reach")); see the ERROR below" ;;
    *)         wr="unknown (listen agent has not run yet)" ;;
  esac
  line "worker" "$wr  ($WORKER_URL)"
  line "last poll" "$(ago "$(cat "$MW_STATE/last-poll-ok" 2>/dev/null)")  (last time the web page's commands were checked)"
  line "last command" "#$(cat "$MW_STATE/last-cmd" 2>/dev/null || echo none)"
fi

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
for l in capture upload listen record events; do
  [ -s "$MW_LOG/$l.log" ] && tail -n 2 "$MW_LOG/$l.log" | sed "s/^/    $l: /"
done
exit 0
