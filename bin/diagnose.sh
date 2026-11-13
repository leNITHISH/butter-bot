#!/bin/sh
# diagnose.sh - print non-secret facts about this Mac and mac-watch, to paste back.
# Never prints the rclone config or token. Takes one test screenshot (not saved).
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
mw_load_config
mkdir -p "$MW_TMP" "$MW_LOG" "$MW_STATE" 2>/dev/null

h() { printf '\n--- %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "mac-watch diagnose  $(date '+%Y-%m-%d %H:%M:%S')"
h "system"
if have sw_vers; then sw_vers; else uname -a; fi
have sysctl && echo "model: $(sysctl -n hw.model 2>/dev/null)  arch: $(uname -m)"
echo "user id: $(id -u)   /bin/sh -> $(ls -l /bin/sh 2>/dev/null | awk '{print $NF}')"
echo "mac-watch folder: $MW_HOME"

h "tools"
for c in screencapture sips ioreg pmset avconvert ffmpeg rclone curl launchctl caffeinate; do
  if have "$c"; then printf '%-14s %s\n' "$c" "$(command -v "$c")"; else printf '%-14s MISSING\n' "$c"; fi
done
have rclone && echo "rclone version: $(rclone version 2>/dev/null | head -n 1)"

h "lid / gate"
echo "lid_state: $(lid_state)"
echo "raw ioreg line: $(ioreg -r -k AppleClamshellState -d 4 2>/dev/null | grep '"AppleClamshellState"' | head -n 1 | sed 's/^[ |]*//')"
if paused; then echo "PAUSE file: PRESENT (nothing will capture)"; else echo "PAUSE file: absent"; fi
have pmset && { echo "power:"; pmset -g batt 2>/dev/null | sed 's/^/  /'; }

h "screencapture test (one shot, deleted afterwards)"
t=$MW_TMP/diagnose.$$.jpg
if have screencapture; then
  # shellcheck disable=SC2086
  screencapture -x -t jpg $SCREENCAPTURE_EXTRA "$t" 2>&1
  echo "exit: $?   size: $(file_size "$t") bytes"
  have sips && sips -g pixelWidth -g pixelHeight "$t" 2>/dev/null | tail -n 2
  echo "(a wallpaper-only shot also looks fine here: confirm real windows with ./bin/selftest.sh)"
  rm -f "${t:?}"
else
  echo "screencapture not found"
fi
if have system_profiler; then
  echo "displays: $(system_profiler SPDisplaysDataType 2>/dev/null | grep -c 'Resolution:')"
fi

h "avconvert presets"
have avconvert && avconvert --help 2>&1 | grep -i 'preset' | head -n 8

h "rclone (names and permissions only; never contents)"
if have rclone; then
  echo "remotes: $(rclone listremotes 2>/dev/null | tr '\n' ' ')"
  cfg=$(rclone config file 2>/dev/null | tail -n 1)
  [ -f "$cfg" ] && ls -l "$cfg" | awk '{print "config file mode/owner: " $1 " " $3}'
  if rclone lsd "$RCLONE_REMOTE:" --max-depth 0 >/dev/null 2>&1; then
    echo "login to $RCLONE_REMOTE: OK"
  else
    echo "login to $RCLONE_REMOTE: FAILED"
  fi
  printf 'online check: '; if is_online; then echo yes; else echo no; fi
fi

h "launchd"
launchctl list 2>/dev/null | grep macwatch || echo "(no com.macwatch jobs loaded)"
if have launchctl; then
  for a in capture upload record; do
    echo "[$a]"; launchctl print "gui/$(id -u)/com.macwatch.$a" 2>&1 | grep -E 'state =|last exit code|runs =|run interval' | head -n 4
  done
fi
for f in "$HOME"/Library/LaunchAgents/*macwatch*; do [ -e "$f" ] && ls -l "$f"; done

h "config.env"
grep -v '^[[:space:]]*#' "$MW_HOME/config.env" 2>/dev/null | grep -v '^[[:space:]]*$'

h "status"
"$MW_BIN/status.sh"

h "last log lines"
for l in capture upload record events; do
  [ -s "$MW_LOG/$l.log" ] && { echo "[$l.log]"; tail -n 8 "$MW_LOG/$l.log"; }
done
for l in capture upload record; do
  [ -s "$MW_LOG/launchd-$l.log" ] && { echo "[launchd-$l.log]"; tail -n 5 "$MW_LOG/launchd-$l.log"; }
done
echo
echo "Hammerspoon: $( [ -d /Applications/Hammerspoon.app ] && echo installed || echo 'not found in /Applications' )"
exit 0
