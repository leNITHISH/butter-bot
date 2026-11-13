#!/bin/sh
# selftest.sh - walks through the Mac-only checks and prints PASS / FAIL / SKIP.
# Interactive: it opens a test screenshot and asks you to confirm real windows are
# visible. Takes a few minutes. Test files it creates are removed again.
#   SELFTEST_AUTO=1  answers "yes" to every question (used by the Linux tests with stubs)
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
mw_init selftest

AUTO=${SELFTEST_AUTO:-0}
P=0; F=0; K=0
pass() { P=$((P + 1)); printf '  PASS  %s\n' "$1"; }
fail() { F=$((F + 1)); printf '  FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '        -> %s\n' "$2"; }
skip() { K=$((K + 1)); printf '  SKIP  %s\n' "$1"; }
info() { printf '        %s\n' "$1"; }
step() { printf '\n[%s]\n' "$1"; }
ask() { # QUESTION -> 0 for yes
  if [ "$AUTO" = 1 ]; then return 0; fi
  printf '        %s [y/N] ' "$1"
  read -r _a
  case $_a in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
pause_enter() { [ "$AUTO" = 1 ] || { printf '        %s ' "$1"; read -r _x; }; }
newest() { find "$1" -type f 2>/dev/null | awk -F/ '{print $NF "\t" $0}' | sort | tail -n 1 | cut -f2-; }
count_files() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }
wait_new() { # DIR COUNT_BEFORE SECONDS
  _i=0
  while [ "$_i" -lt "$3" ]; do
    [ "$(count_files "$1")" -gt "$2" ] && return 0
    sleep 1; _i=$((_i + 1))
  done
  return 1
}
# shellcheck disable=SC2329  # called by trap
cleanup() { rm -f "${MW_PAUSE:?}"; }

if paused; then
  echo "A PAUSE file exists ($MW_PAUSE). Remove it first (rm \"$MW_PAUSE\"), then re-run; the test needs captures enabled."
  exit 1
fi
trap cleanup EXIT
trap 'exit 1' INT TERM HUP
uid=$(id -u)

echo "mac-watch selftest"

step "1. tools"
miss=
for c in screencapture sips ioreg curl launchctl rclone; do command -v "$c" >/dev/null 2>&1 || miss="$miss $c"; done
if [ -z "$miss" ]; then pass "required tools found"; else fail "missing:$miss" "brew install rclone (the rest ships with macOS)"; fi
if command -v avconvert >/dev/null 2>&1; then pass "avconvert present (recording compression)"; else skip "avconvert missing: recordings stay uncompressed unless ffmpeg is installed"; fi

step "2. lid state"
ls=$(lid_state)
case $ls in
  open|closed) pass "AppleClamshellState readable: lid is $ls" ;;
  *) fail "AppleClamshellState not found in ioreg" "mac-watch will treat the lid as open; paste ./bin/diagnose.sh output to Claude" ;;
esac
[ "$ls" = closed ] && info "(lid reads closed; the capture steps below need it open)"

step "3. screenshot taken by the real LaunchAgent (this is the permission that matters)"
if [ "$AUTO" != 1 ] && ! launchctl list 2>/dev/null | grep -q 'com\.macwatch\.capture'; then
  fail "agent com.macwatch.capture is not loaded" "run ./bin/install.sh"
else
  pass "capture agent is loaded"
  rm -f "${MW_STATE:?}/last-trigger-interval"
  before=$(count_files "$MW_QUEUE/shots")
  if [ "$AUTO" = 1 ]; then "$MW_BIN/trigger.sh" interval; else launchctl kickstart -k "gui/$uid/com.macwatch.capture" >/dev/null 2>&1; fi
  if wait_new "$MW_QUEUE/shots" "$before" 20; then
    shot=$(newest "$MW_QUEUE/shots")
    pass "agent produced $(basename "$shot") ($(file_size "$shot") bytes)"
    info "Opening it now. Look for your real windows, not just the wallpaper and menu bar."
    [ "$AUTO" = 1 ] || open "$shot"
    if ask "Do you see your real windows in the picture?"; then
      pass "screenshots show real windows (Screen Recording permission works for the agent)"
    else
      fail "wallpaper-only screenshot: Screen Recording permission is missing for the launchd job" \
           "Grant /bin/sh in System Settings > Privacy & Security > Screen & System Audio Recording (+ then Cmd+Shift+G, /bin/sh). Still blank? run ./bin/install.sh --wrapper and grant MacWatch. Then re-run this test."
    fi
  else
    fail "no screenshot appeared within 20 s" "check ./bin/status.sh and log/capture.log (is the lid open?)"
  fi
fi

step "4. displays"
if command -v system_profiler >/dev/null 2>&1; then
  nd=$(system_profiler SPDisplaysDataType 2>/dev/null | grep -c 'Resolution:')
  info "$nd display(s) detected."
  [ "${nd:-1}" -gt 1 ] && info "Several displays: check the picture above covers what you want. To capture only the main display set SCREENCAPTURE_EXTRA=\"-m\" in config.env."
  pass "display count noted"
else
  skip "system_profiler not available"
fi

step "5. PAUSE kill switch"
# Judge by the capture state file, not by counting queue files: the upload agent
# may move files out of the queue while this runs.
touch "$MW_PAUSE"
rm -f "${MW_STATE:?}/last-trigger-selftest"
before=$(cat "$MW_STATE/last-capture" 2>/dev/null)
"$MW_BIN/trigger.sh" selftest
after=$(cat "$MW_STATE/last-capture" 2>/dev/null)
rm -f "${MW_PAUSE:?}"
if [ "$before" = "$after" ]; then pass "PAUSE blocks capture"; else fail "a capture happened while PAUSE existed"; fi
"$MW_BIN/trigger.sh" selftest
case $(cat "$MW_STATE/last-capture" 2>/dev/null) in
  *'|selftest|'*'|ok') pass "capture resumes when PAUSE is removed" ;;
  *) fail "no capture after removing PAUSE" "$(cut -d' ' -f2- "$MW_STATE/error-capture" 2>/dev/null) (lid closed? see log/capture.log)" ;;
esac

step "6. Google Drive login"
if ! command -v rclone >/dev/null 2>&1; then
  skip "rclone not installed"
elif rc lsd "$RCLONE_REMOTE:" --max-depth 0 >/dev/null 2> "$MW_TMP/lsd.err"; then
  pass "rclone remote '$RCLONE_REMOTE' can reach Drive"
  cfg=$(rclone config file 2>/dev/null | tail -n 1)
  if [ -f "$cfg" ]; then
    case $(ls -l "$cfg" | awk '{print $1}') in
      -rw-------*) pass "rclone config is chmod 600" ;;
      *) fail "rclone config is readable by others" "run: chmod 600 \"$cfg\"" ;;
    esac
  fi
  note=selftest-$(date +%H%M%S).txt
  echo "mac-watch selftest" > "$MW_TMP/$note"
  if rc copyto "$MW_TMP/$note" "$(rpath control)/$note" 2>/dev/null && rc deletefile "$(rpath control)/$note" --drive-use-trash=false 2>/dev/null; then
    pass "write + delete in Drive $DRIVE_FOLDER/control/ works"
  else
    fail "could not write/delete in Drive $DRIVE_FOLDER/control/" "run: rclone config reconnect $RCLONE_REMOTE:"
  fi
  rm -f "${MW_TMP:?}/${note:?}"
elif grep -qi 'ratelimit\|rate limit' "$MW_TMP/lsd.err" 2>/dev/null; then
  fail "Google Drive is rate-limiting rclone's shared client ID" "this is the known risk: run ./bin/setup-oauth.sh to use your own Google client (free, ~10 min, see README)"
else
  fail "rclone cannot reach Drive with remote '$RCLONE_REMOTE'" "run ./bin/setup-drive.sh (or: rclone config reconnect $RCLONE_REMOTE:)"
fi
rm -f "${MW_TMP:?}/lsd.err"

step "7. upload of the real shots"
if command -v rclone >/dev/null 2>&1 && is_online; then
  "$MW_BIN/upload.sh"
  [ "$AUTO" = 1 ] || sleep 16   # rclone only moves files that are 15 s old
  "$MW_BIN/upload.sh"
  left=$(queue_count)
  if [ "$left" = 0 ]; then pass "queue is empty after upload"; else fail "$left file(s) still queued" "see ./bin/status.sh and log/upload.log"; fi
  if [ -f "$MW_STATE/error-upload" ]; then fail "upload error flag is set" "$(cut -d' ' -f2- "$MW_STATE/error-upload")"; fi
else
  skip "offline or no rclone"
fi

step "8. phone marker round trip (snap-now)"
if command -v rclone >/dev/null 2>&1 && is_online && rc lsd "$RCLONE_REMOTE:" --max-depth 0 >/dev/null 2>&1; then
  count_remote() { rc lsf -R "$(rpath shots)" 2>/dev/null | grep -c -- '-remote\.jpg'; }
  b=$(count_remote)
  rc mkdir "$(rpath control)/snap-now" 2>/dev/null
  info "Created the folder control/snap-now in Drive (like your phone would)."
  if [ "$AUTO" = 1 ]; then
    "$MW_BIN/upload.sh"; wait_s=5
  else
    wait_s=$((CONTROL_POLL_SEC * 2 + 60))
    info "Waiting up to ${wait_s}s for the upload agent to notice it..."
  fi
  i=0; got=0
  while [ "$i" -lt "$wait_s" ]; do
    a=$(count_remote)
    if [ "${a:-0}" -gt "${b:-0}" ]; then got=1; break; fi
    sleep 3; i=$((i + 3))
  done
  if [ "$got" = 1 ]; then pass "snap-now produced a *-remote.jpg in Drive after about ${i}s"; else fail "no remote shot appeared" "is com.macwatch.upload loaded? see log/upload.log"; fi
  if rc lsf "$(rpath control)" 2>/dev/null | grep -qi '^snap-now'; then
    fail "marker was not deleted from Drive control/"
    rc purge "$(rpath control)/snap-now" --drive-use-trash=false 2>/dev/null
  else
    pass "marker was deleted by mac-watch"
  fi
else
  skip "Drive not reachable"
fi

step "9. screen recording (10 s) and the stop switch"
if ask "Run a 10-second test recording now? (macOS shows its recording indicator; screen only, no audio)"; then
  before=$(count_files "$MW_QUEUE/recordings")
  "$MW_BIN/record.sh" 10 selftest
  if wait_new "$MW_QUEUE/recordings" "$before" 5; then
    mov=$(newest "$MW_QUEUE/recordings")
    pass "recording queued: $(basename "$mov") ($(file_size "$mov") bytes)"
    [ "$AUTO" = 1 ] || open "$mov"
    if ask "Does the movie play and show your screen (no audio expected)?"; then pass "recording plays"; else fail "recording does not play or is blank" "Screen Recording permission, or send ./bin/diagnose.sh output"; fi
  else
    fail "no recording file produced" "see log/record.log"
  fi
  info "Now the stop switch: a 30 s recording, PAUSE appears after 5 s."
  before=$(count_files "$MW_QUEUE/recordings")
  "$MW_BIN/record.sh" 30 selftest-stop &
  rp=$!
  if [ "$AUTO" = 1 ]; then sleep 1; else sleep 5; fi; touch "$MW_PAUSE"
  t0=$(now); wait "$rp"; took=$(( $(now) - t0 ))
  rm -f "${MW_PAUSE:?}"
  if [ "$took" -lt 20 ] && wait_new "$MW_QUEUE/recordings" "$before" 5; then
    pass "PAUSE stopped the recording after ${took}s and the partial file was kept"
    if grep -q 'sent TERM\|sent KILL' "$MW_LOG/record.log" 2>/dev/null; then info "note: SIGINT alone did not stop screencapture; see log/record.log"; fi
    [ "$AUTO" = 1 ] || { open "$(newest "$MW_QUEUE/recordings")"; ask "Does the partial movie (about 5-10 s) play?" && pass "partial recording plays" || fail "partial recording is unplayable" "tell Claude: the stop signal corrupts the file; see log/record.log"; }
  else
    fail "stop switch did not behave (took ${took}s)" "see log/record.log"
  fi
else
  skip "recording test"
fi

step "10. Hammerspoon triggers (Phase 3, optional)"
if [ -d /Applications/Hammerspoon.app ] || [ -d "$HOME/Applications/Hammerspoon.app" ] || [ "$AUTO" = 1 ]; then
  pass "Hammerspoon installed"
  if ask "Is Hammerspoon running with mac-watch loaded (./bin/install.sh --hammerspoon, then Reload Config)?"; then
    rm -f "${MW_STATE:?}/last-trigger-space"
    pause_enter "Press Enter here, then tap the SPACEBAR once in any other app within 10 s..."
    if [ "$AUTO" = 1 ]; then "$MW_BIN/trigger.sh" space; fi
    i=0; got=0
    while [ "$i" -lt 10 ]; do
      case $(cat "$MW_STATE/last-capture" 2>/dev/null) in *'|space|'*) got=1; break ;; esac
      sleep 1; i=$((i + 1))
    done
    if [ "$got" = 1 ]; then pass "spacebar produced a -space.jpg"; else fail "no spacebar shot" "Hammerspoon needs Accessibility + Input Monitoring (System Settings > Privacy & Security); see README"; fi
  else
    skip "Hammerspoon not loaded yet"
  fi
else
  skip "Hammerspoon not installed (brew install --cask hammerspoon); optional"
fi
if ioreg -c IOHIDSystem 2>/dev/null | grep -q HIDIdleTime; then
  pass "HIDIdleTime readable (the no-extra-permission fallback to Hammerspoon exists)"
else
  skip "HIDIdleTime not readable"
fi

step "11. things only you can check"
info "a) Reboot, log in, run ./bin/status.sh: capture/upload/record should say 'loaded' without you doing anything."
info "b) Turn Wi-Fi off for 15 min: status.sh shows the queue growing; turn it on, and it empties within ~5 min."
info "c) Lid closed: only testable with an external monitor (otherwise the Mac sleeps). With the lid shut, status.sh shows no new capture."
info "d) Watch for macOS asking to re-approve screen recording; if shots go blank later, that is why."

echo
echo "result: $P passed, $F failed, $K skipped"
[ "$F" -eq 0 ]
