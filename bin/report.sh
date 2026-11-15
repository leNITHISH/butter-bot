#!/bin/sh
# report.sh - write state/status.json: what the web dashboard shows about this Mac.
# Contains no secrets and no screen content: times, counts, battery, error text.
# listen.sh posts it to the Worker (POST /mac/status) every 5 minutes and on changes.
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
mw_init events

# one-line JSON-safe string: no quotes, backslashes or control characters, max 200 chars
js() { printf '%s' "$1" | tr -d '"\\' | tr '\n\r\t' '   ' | cut -c1-200; }

lc=$(cat "$MW_STATE/last-capture" 2>/dev/null)
lc_e=${lc%%|*}; _r=${lc#*|}; lc_reason=${_r%%|*}; _r=${_r#*|}; lc_name=${_r%%|*}; lc_res=${_r#*|}
case $lc_e in ''|*[!0-9]*) lc_e=0 ;; esac

if paused_local; then pz=local; elif paused_remote; then pz=remote; else pz=no; fi

pw=$(pmset -g batt 2>/dev/null)
case $(printf '%s' "$pw" | head -n 1) in
  *"AC Power"*) power=AC ;; *"Battery Power"*) power=Battery ;; *) power=unknown ;;
esac
batt=$(printf '%s' "$pw" | grep -o '[0-9]*%' | head -n 1)
up=$(uptime | sed -e 's/^.*up *//' -e 's/, *[0-9][0-9]* user.*$//' -e 's/  */ /g')

errs=
for f in "$MW_STATE"/error-*; do
  [ -f "$f" ] || continue
  errs="$errs${errs:+ | }${f##*/error-}: $(cut -d' ' -f2- "$f")"
done

if [ -e "$MW_STATE/hammerspoon-enabled" ]; then
  if pgrep -x Hammerspoon >/dev/null 2>&1; then hs=running; else hs=not-running; fi
else
  hs=off
fi
lu=$(cat "$MW_STATE/last-upload-ok" 2>/dev/null); case $lu in ''|*[!0-9]*) lu=0 ;; esac
rc_n=$(grep -c . "$MW_STATE/remote.conf" 2>/dev/null); rc_n=${rc_n:-0}
ver=$(git -C "$MW_HOME" rev-parse --short HEAD 2>/dev/null)
dfree=$(df -k "$MW_HOME" 2>/dev/null | awk 'NR == 2 { printf "%.1f", $4 / 1048576 }')
case $dfree in ''|*[!0-9.]*) dfree=null ;; esac
qkb=$(du -sk "$MW_QUEUE" 2>/dev/null | awk '{print $1}')
case $qkb in ''|*[!0-9]*) qkb=0 ;; esac
lshots=$(find "$MW_QUEUE/shots" -type f -name '*.jpg' 2>/dev/null | wc -l | tr -d ' ')
lpoll=$(cat "$MW_STATE/last-poll-ok" 2>/dev/null); case $lpoll in ''|*[!0-9]*) lpoll=0 ;; esac

out=$MW_STATE/status.json
{
  printf '{\n'
  printf '  "updated": %s,\n' "$(now)"
  printf '  "host": "%s",\n' "$(js "$(hostname -s 2>/dev/null)")"
  printf '  "version": "%s",\n' "$(js "$ver")"
  printf '  "lid": "%s",\n' "$(lid_state)"
  printf '  "paused": "%s",\n' "$pz"
  printf '  "online": "%s",\n' "$(js "$(cat "$MW_STATE/online" 2>/dev/null)")"
  printf '  "lastCapture": {"epoch": %s, "reason": "%s", "name": "%s", "result": "%s"},\n' "$lc_e" "$(js "$lc_reason")" "$(js "$lc_name")" "$(js "$lc_res")"
  printf '  "queue": %s,\n' "$(queue_count)"
  printf '  "queueMB": %s,\n' "$(awk -v k="$qkb" 'BEGIN { printf "%.1f", k / 1024 }')"
  printf '  "localShots": %s,\n' "${lshots:-0}"
  printf '  "diskFreeGB": %s,\n' "$dfree"
  printf '  "lastPollOk": %s,\n' "$lpoll"
  printf '  "lastUploadOk": %s,\n' "$lu"
  printf '  "battery": "%s",\n' "$(js "$batt")"
  printf '  "power": "%s",\n' "$power"
  printf '  "uptime": "%s",\n' "$(js "$up")"
  printf '  "hammerspoon": "%s",\n' "$hs"
  printf '  "keepAwake": %s,\n' "$KEEP_AWAKE"
  printf '  "intervalSec": %s,\n' "$INTERVAL_SEC"
  printf '  "remoteSettings": %s,\n' "$rc_n"
  printf '  "errors": "%s"\n' "$(js "$errs")"
  printf '}\n'
} > "$out.new" && mv "$out.new" "$out"
exit 0
