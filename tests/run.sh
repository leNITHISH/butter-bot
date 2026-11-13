#!/bin/sh
# tests/run.sh - plain shell tests for mac-watch; no framework.
# Runs on Linux (and macOS). Every Mac-only command is a stub in tests/stubs/.
#   ./tests/run.sh            run everything
#   SH=dash ./tests/run.sh    choose the shell the scripts run under (default: sh)
#   ./tests/run.sh marker     only tests whose name contains "marker"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SH=${SH:-sh}
FILTER=${1:-}
REAL_RCLONE=$(command -v rclone 2>/dev/null)

PASS=0; FAILN=0
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAILN=$((FAILN + 1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
check() { # DESC CMD...   passes when the command succeeds
  _d=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$_d"; else bad "$_d"; fi
}
eq() { # DESC EXPECTED ACTUAL
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$2' got '$3'"; fi
}
has() { # DESC FILE PATTERN
  if grep -q -- "$3" "$2" 2>/dev/null; then ok "$1"; else bad "$1" "no '$3' in $2"; fi
}
hasnt() { # DESC FILE PATTERN
  if grep -q -- "$3" "$2" 2>/dev/null; then bad "$1" "found '$3' in $2"; else ok "$1"; fi
}

new_env() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/mwtest.XXXXXX")
  export STUB_DIR=$T/stub STUB_RCLONE_ROOT=$T/drive MW_HOME=$T/home
  mkdir -p "$STUB_DIR" "$STUB_RCLONE_ROOT" "$MW_HOME"
  cp "$ROOT/config.env" "$MW_HOME/config.env"
  echo "SKIP_IDENTICAL=0" >> "$MW_HOME/config.env"   # the skip tests turn it on
  PATH=$ROOT/tests/stubs:$ORIG_PATH
  export PATH
  # fast internals
  export UPLOAD_EVERY_SEC=0 PRUNE_EVERY_SEC=0 SETTLE_SEC=0 WATCHDOG_POLL_SEC=1 STOP_GRACE_SEC=1
  unset STUB_DARWIN STUB_REC_MAX STUB_WIDTH
  Q=$MW_HOME/queue; D=$STUB_RCLONE_ROOT/mac-watch; L=$MW_HOME/log; S=$MW_HOME/state
  TODAY=$(date +%Y-%m-%d)
}
end_env() { rm -rf "$T"; }
cfg() { printf '%s\n' "$1" >> "$MW_HOME/config.env"; }   # later lines win
run() { _s=$1; shift; $SH "$ROOT/bin/$_s" "$@"; }
nfiles() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }
nshots() { nfiles "$Q/shots"; }
first_file() { find "$1" -type f 2>/dev/null | sort | head -n 1; }
old() { touch -t 202001010000 "$1"; }

section() { printf '\n== %s\n' "$1"; _skip=0; case $1 in *"$FILTER"*) ;; *) _skip=1 ;; esac; [ "$_skip" = 0 ]; }

ORIG_PATH=$PATH

# ============================================================================
if section "gate: lid and PAUSE"; then
  new_env
  run trigger.sh interval; eq "lid open: one shot taken" 1 "$(nshots)"
  rm -rf "$Q/shots" "$S"
  echo closed > "$STUB_DIR/lid"
  run trigger.sh interval; eq "lid closed: nothing captured" 0 "$(nshots)"
  : > "$STUB_DIR/calls"
  run trigger.sh wake
  hasnt "lid closed: screencapture never called" "$STUB_DIR/calls" "^screencapture"
  has "lid closed: reason is logged" "$L/capture.log" "skip: lid closed"
  echo open > "$STUB_DIR/lid"; touch "$MW_HOME/PAUSE"
  run trigger.sh interval; eq "PAUSE file: nothing captured" 0 "$(nshots)"
  has "PAUSE: reason is logged" "$L/capture.log" "PAUSE"
  rm "$MW_HOME/PAUSE"
  run trigger.sh interval; eq "PAUSE removed: captures again" 1 "$(nshots)"
  rm -rf "$Q/shots"; echo missing > "$STUB_DIR/lid"
  run trigger.sh space; run trigger.sh wake
  eq "lid key missing: treated as open" 2 "$(nshots)"
  eq "lid key missing: logged only once" 1 "$(grep -c 'AppleClamshellState not found' "$L/capture.log")"
  end_env
fi

if section "capture: file name, location, atomicity"; then
  new_env
  run trigger.sh space; f=$(first_file "$Q/shots")
  case $f in */shots/$TODAY/[0-9]*-[0-9]*-space.jpg) ok "name is YYYYMMDD-HHMMSS-reason.jpg in shots/DATE/" ;; *) bad "name/location" "$f" ;; esac
  eq "tmp/ is empty afterwards" 0 "$(nfiles "$MW_HOME/tmp")"
  run trigger.sh 'bad reason!'; eq "bad reason is rejected (exit 2)" 2 $?
  eq "last-capture state written" ok "$(cut -d'|' -f4 "$S/last-capture")"
  end_env
  new_env
  touch "$STUB_DIR/screencapture_fail"
  run trigger.sh interval; eq "failed capture: exit nonzero" 1 $?
  eq "failed capture: nothing queued" 0 "$(nshots)"
  check "failed capture: error flag set" test -f "$S/error-capture"
  rm "$STUB_DIR/screencapture_fail"; rm -f "$S/last-trigger-interval"; run trigger.sh interval
  check "later success clears the error flag" test ! -f "$S/error-capture"
  end_env
  new_env
  STUB_WIDTH=2880 run trigger.sh space
  has "wide screen is shrunk to MAX_WIDTH" "$STUB_DIR/calls" "resampleWidth 1440"
  : > "$STUB_DIR/calls"
  STUB_WIDTH=1000 run trigger.sh wake
  hasnt "narrow screen is never enlarged" "$STUB_DIR/calls" "resampleWidth"
  touch "$STUB_DIR/sips_fail"; run trigger.sh lock
  eq "sips failure: uncompressed shot still queued" 3 "$(nshots)"
  end_env
fi

if section "debounce"; then
  new_env
  run trigger.sh space; run trigger.sh space; run trigger.sh space
  eq "three spaces within the gap: one shot" 1 "$(nshots)"
  run trigger.sh interval
  eq "other reasons are independent" 2 "$(nshots)"
  echo 1000 > "$S/last-trigger-space"; sleep 1
  run trigger.sh space
  eq "after the gap passes: shot again" 3 "$(nshots)"
  cfg SPACE_MIN_GAP_SEC=0
  run trigger.sh space; run trigger.sh space
  eq "gap 0: no debounce" 5 "$(nshots)"
  end_env
  new_env
  run trigger.sh interval; run trigger.sh interval
  eq "interval shots are debounced too" 1 "$(nshots)"
  run trigger.sh selftest; run trigger.sh selftest
  eq "unknown reasons have no debounce" 3 "$(nshots)"
  end_env
fi

if section "skip identical frames"; then
  new_env
  cfg SKIP_IDENTICAL=1
  echo "screen-A" > "$STUB_DIR/screen"
  run trigger.sh interval; echo 1000 > "$S/last-trigger-interval"
  run trigger.sh interval
  eq "unchanged screen: second interval shot skipped" 1 "$(nshots)"
  has "skip is logged" "$L/capture.log" "unchanged"
  echo "screen-B" > "$STUB_DIR/screen"; echo 1000 > "$S/last-trigger-interval"
  run trigger.sh interval
  eq "changed screen: kept" 2 "$(nshots)"
  echo 1000 > "$S/last-trigger-interval"; echo 1000 > "$S/last-keep"
  run trigger.sh interval
  eq "unchanged but older than SKIP_MAX_AGE_SEC: kept (proof of life)" 3 "$(nshots)"
  echo 1000 > "$S/last-trigger-space"; run trigger.sh space
  eq "spacebar shot is never skipped" 4 "$(nshots)"
  end_env
  new_env
  cfg SKIP_IDENTICAL=0
  run trigger.sh interval; echo 1000 > "$S/last-trigger-interval"; run trigger.sh interval
  eq "SKIP_IDENTICAL=0 keeps everything" 2 "$(nshots)"
  end_env
fi

# ============================================================================
if section "upload: online, offline, gate"; then
  new_env
  run trigger.sh space
  f=$(first_file "$Q/shots"); fname=${f##*/}
  run upload.sh
  eq "online: queue emptied" 0 "$(nfiles "$Q")"
  check "online: file is in Drive shots/DATE/" test -f "$D/shots/$TODAY/$fname"
  check "online: last-upload-ok recorded" test -s "$S/last-upload-ok"
  check "online: queue root still exists" test -d "$Q"
  rm -rf "$D"
  touch "$STUB_DIR/offline"
  run trigger.sh wake; run trigger.sh lock
  run upload.sh; eq "offline: exit 0" 0 $?
  eq "offline: files stay queued" 2 "$(nshots)"
  check "offline: nothing created in Drive" test ! -d "$D/shots"
  hasnt "offline: no ERROR logged" "$L/upload.log" "ERROR"
  rm "$STUB_DIR/offline"
  run upload.sh
  eq "back online: queue drains" 0 "$(nfiles "$Q")"
  eq "back online: both files in Drive" 2 "$(nfiles "$D/shots")"
  end_env
  new_env
  run trigger.sh space
  echo closed > "$STUB_DIR/lid"; run upload.sh
  eq "lid closed: no upload" 1 "$(nshots)"
  echo open > "$STUB_DIR/lid"; touch "$MW_HOME/PAUSE"; run upload.sh
  eq "PAUSE: no upload" 1 "$(nshots)"
  rm "$MW_HOME/PAUSE"; run upload.sh
  eq "resumed: uploaded" 0 "$(nshots)"
  end_env
  new_env
  mkdir -p "$Q/shots/$TODAY" "$Q/recordings/$TODAY"
  echo a > "$Q/shots/$TODAY/20261113-100000-interval.jpg"
  echo b > "$Q/recordings/$TODAY/20261113-100000-rec.mov"
  echo c > "$Q/control-note.txt"; mkdir -p "$Q/control"; echo c > "$Q/control/done-x-1.txt"
  run upload.sh
  check "jpg goes to shots/DATE/" test -f "$D/shots/$TODAY/20261113-100000-interval.jpg"
  check "mov goes to recordings/DATE/" test -f "$D/recordings/$TODAY/20261113-100000-rec.mov"
  check "done note goes to control/" test -f "$D/control/done-x-1.txt"
  end_env
fi

if section "upload: loud auth failures, no secrets in logs"; then
  new_env
  run trigger.sh space
  echo '1|couldn'"'"'t get token: oauth2: cannot fetch token: 400 {"error":"invalid_grant","access_token":"ya29.SUPERSECRETVALUE12345"}' > "$STUB_DIR/rclone_fail"
  run upload.sh
  has "ERROR line in upload.log" "$L/upload.log" "ERROR"
  has "auth hint tells you the fix" "$L/upload.log" "rclone config reconnect"
  hasnt "token value never reaches the log" "$L/upload.log" "SUPERSECRETVALUE"
  eq "failed upload keeps the file" 1 "$(nshots)"
  run status.sh > "$T/status.txt"
  has "status.sh shows the error" "$T/status.txt" "ERROR upload"
  hasnt "status.sh never shows the token" "$T/status.txt" "SUPERSECRETVALUE"
  rm "$STUB_DIR/rclone_fail"; run upload.sh
  eq "recovery: uploaded" 0 "$(nshots)"
  check "recovery: error flag cleared" test ! -f "$S/error-upload"
  end_env
fi

if section "queue cap"; then
  new_env
  cfg QUEUE_MAX_FILES=3
  touch "$STUB_DIR/offline"
  mkdir -p "$Q/shots/2026-11-12" "$Q/shots/2026-11-13"
  for n in 1 2 3 4 5 6; do echo x > "$Q/shots/2026-11-1$((n < 4 ? 2 : 3))/2026111$((n < 4 ? 2 : 3))-10000$n-interval.jpg"; done
  run upload.sh
  eq "offline: capped to QUEUE_MAX_FILES" 3 "$(nshots)"
  eq "oldest are deleted first" "20261113-100004-interval.jpg" "$(find "$Q/shots" -type f | sed 's|.*/||' | sort | head -n 1)"
  has "deletion is logged" "$L/upload.log" "deleted 3 oldest"
  check "empty date folder removed" test ! -d "$Q/shots/2026-11-12"
  end_env
  new_env
  cfg QUEUE_MAX_MB=1
  touch "$STUB_DIR/offline"; mkdir -p "$Q/shots/2026-11-13"
  for n in 1 2 3; do dd if=/dev/zero of="$Q/shots/2026-11-13/2026111$n-000000-interval.jpg" bs=1024 count=600 2>/dev/null; done
  run upload.sh
  check "size cap: shrinks below QUEUE_MAX_MB" test "$(nshots)" -le 1
  end_env
fi

if section "locks"; then
  new_env
  run trigger.sh space
  mkdir -p "$S/upload.lock"; echo $$ > "$S/upload.lock/pid"
  run upload.sh
  eq "fresh lock with a live owner: upload skipped" 1 "$(nshots)"
  old "$S/upload.lock"
  run upload.sh
  eq "old lock (>10 min): treated as stale, upload runs" 0 "$(nshots)"
  has "stale lock is logged" "$L/upload.log" "stale lock"
  run trigger.sh wake
  mkdir -p "$S/upload.lock"; echo 999999 > "$S/upload.lock/pid"
  run upload.sh
  eq "lock whose owner is dead: stale, upload runs" 0 "$(nshots)"
  check "lock is released after a run" test ! -d "$S/upload.lock"
  end_env
fi

if section "prune"; then
  new_env
  mkdir -p "$D/shots/2020-01-01" "$D/shots/$TODAY" "$D/recordings/2020-01-01" "$D/control"
  echo o > "$D/shots/2020-01-01/old.jpg"; old "$D/shots/2020-01-01/old.jpg"
  echo o > "$D/recordings/2020-01-01/old.mov"; old "$D/recordings/2020-01-01/old.mov"
  echo n > "$D/shots/$TODAY/new.jpg"
  echo o > "$D/control/done-a-1.txt"; old "$D/control/done-a-1.txt"
  echo o > "$D/control/README.txt"; old "$D/control/README.txt"
  run upload.sh
  check "old shot pruned" test ! -f "$D/shots/2020-01-01/old.jpg"
  check "old recording pruned" test ! -f "$D/recordings/2020-01-01/old.mov"
  check "empty date folder removed" test ! -d "$D/shots/2020-01-01"
  check "new shot kept" test -f "$D/shots/$TODAY/new.jpg"
  check "old done-note pruned" test ! -f "$D/control/done-a-1.txt"
  check "other files in control/ are never touched" test -f "$D/control/README.txt"
  check "shots root survives" test -d "$D/shots"
  end_env
fi

# ============================================================================
if section "markers"; then
  new_env
  mkdir -p "$D/control"; : > "$D/control/snap-now"
  run upload.sh
  eq "snap-now file: one remote shot" 1 "$(find "$D/shots" -name '*-remote.jpg' | wc -l | tr -d ' ')"
  check "snap-now: marker deleted" test ! -e "$D/control/snap-now"
  eq "snap-now: shot uploaded the same run, queue empty" 0 "$(nfiles "$Q")"
  end_env
  new_env
  mkdir -p "$D/control/Snap-Now (2)"
  run upload.sh
  eq "marker FOLDER, mixed case, extra text: works" 1 "$(find "$D/shots" -name '*-remote.jpg' | wc -l | tr -d ' ')"
  check "folder marker deleted" test ! -e "$D/control/Snap-Now (2)"
  end_env
  new_env
  mkdir -p "$D/control/snap-now" "$D/control/notes"; : > "$D/control/hello.txt"; : > "$D/control/snap-later"
  old "$D/control/snap-now"
  run upload.sh
  eq "stale marker: no shot" 0 "$(find "$D/shots" -name '*.jpg' 2>/dev/null | wc -l | tr -d ' ')"
  check "stale marker: still deleted" test ! -e "$D/control/snap-now"
  has "stale marker: logged" "$L/upload.log" "not acted on"
  check "unrelated names are left alone" test -e "$D/control/hello.txt" -a -d "$D/control/notes" -a -e "$D/control/snap-later"
  end_env
  new_env
  mkdir -p "$D/control"; : > "$D/control/snap-now"; touch "$STUB_DIR/rclone_nodelete"
  run upload.sh
  eq "marker that cannot be deleted: NOT acted on" 0 "$(nshots)"
  has "undeletable marker: loud error" "$L/upload.log" "not acting on it"
  rm "$STUB_DIR/rclone_nodelete"
  end_env
  new_env
  mkdir -p "$D/control"; : > "$D/control/snap-now"; touch "$STUB_DIR/offline"
  run upload.sh
  check "offline: markers are not processed" test -e "$D/control/snap-now"
  eq "offline: no shot" 0 "$(nshots)"
  end_env
  new_env
  echo closed > "$STUB_DIR/lid"; mkdir -p "$D/control"; : > "$D/control/snap-now"
  run upload.sh
  check "lid closed: markers wait (not deleted)" test -e "$D/control/snap-now"
  end_env
  new_env
  run upload.sh
  check "missing control/ folder is created" test -d "$D/control"
  end_env
  new_env
  mkdir -p "$D/control"; : > "$D/control/snap-now"; : > "$D/control/SNAP-NOW-again"
  run upload.sh
  eq "two snap markers in one poll: debounced to one shot" 1 "$(find "$D/shots" -name '*-remote.jpg' | wc -l | tr -d ' ')"
  eq "both markers deleted" 0 "$(find "$D/control" -mindepth 1 | wc -l | tr -d ' ')"
  end_env
  new_env
  mkdir -p "$D/control/record-5min"
  run upload.sh
  has "record marker: record agent kickstarted" "$STUB_DIR/calls" "kickstart gui/.*/com.macwatch.record"
  eq "record marker: name handed over" "record-5min" "$(cat "$S/record-request")"
  check "record marker deleted" test ! -e "$D/control/record-5min"
  : > "$STUB_DIR/calls"; rm "$S/record-request"
  mkdir -p "$S/record.lock" "$D/control/record-5min"
  run upload.sh
  hasnt "recording already running: no second kickstart" "$STUB_DIR/calls" "kickstart"
  rm -rf "$S/record.lock"; : > "$STUB_DIR/calls"; touch "$STUB_DIR/launchctl_fail"
  mkdir -p "$D/control/record-5min"
  run upload.sh
  check "kickstart failure is an error flag" test -f "$S/error-record"
  end_env
fi

if section "wall_to_secs"; then
  new_env
  w() { MW_BIN=$ROOT/bin; . "$ROOT/bin/lib.sh"; wall_to_secs "$1"; }
  eq "epoch zero" 0 "$(w '1970-01-01 00:00:00')"
  eq "leap year day" 951868800 "$(w '2000-03-01 00:00:00')"
  eq "matches GNU/BSD date" "$(date -u -d '2026-11-13 15:28:09' +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S' '2026-11-13 15:28:09' +%s)" "$(w '2026-11-13 15:28:09')"
  eq "one day apart" 86400 "$(( $(w '2026-03-01 00:00:00') - $(w '2026-02-28 00:00:00') ))"
  eq "garbage gives empty" "" "$(w 'nonsense')"
  end_env
fi

# ============================================================================
if section "record"; then
  new_env
  STUB_REC_MAX=1 run record.sh 3 record-5min
  f=$(first_file "$Q/recordings")
  case $f in */recordings/$TODAY/*-rec.mov) ok "recording queued as ...-rec.mov under recordings/DATE/" ;; *) bad "recording location" "$f" ;; esac
  has "recorded with -v -V N, no audio flag" "$STUB_DIR/calls" "screencapture -v -V 3 -x"
  hasnt "never asks for audio" "$STUB_DIR/calls" " -g"
  has "compressed with avconvert preset" "$STUB_DIR/calls" "avconvert --preset Preset1280x720"
  eq "compressed copy is what is queued" 10 "$(wc -c < "$f" | tr -d ' ')"
  n=$(first_file "$Q/control")
  case ${n##*/} in done-record-5min-*.txt) ok "done note queued" ;; *) bad "done note" "$n" ;; esac
  has "done note says what ran" "$n" "recordings/$TODAY"
  check "tmp/ clean afterwards" test "$(nfiles "$MW_HOME/tmp")" = 0
  check "lock released" test ! -d "$S/record.lock"
  end_env
  new_env
  touch "$STUB_DIR/avconvert_fail"
  STUB_REC_MAX=1 run record.sh 3
  eq "avconvert fails, no ffmpeg: original kept" 1 "$(nfiles "$Q/recordings")"
  has "fallback is logged" "$L/record.log" "keeping the original"
  eq "no marker: no done note" 0 "$(nfiles "$Q/control")"
  end_env
  new_env
  mkdir -p "$S/record.lock"; echo $$ > "$S/record.lock/pid"
  STUB_REC_MAX=1 run record.sh 3
  eq "second recording while one runs: refused" 0 "$(nfiles "$Q/recordings")"
  rm -rf "$S/record.lock"
  echo closed > "$STUB_DIR/lid"; STUB_REC_MAX=1 run record.sh 3
  eq "lid closed at start: no recording" 0 "$(nfiles "$Q/recordings")"
  echo open > "$STUB_DIR/lid"; touch "$MW_HOME/PAUSE"; STUB_REC_MAX=1 run record.sh 3
  eq "PAUSE: no recording" 0 "$(nfiles "$Q/recordings")"
  rm "$MW_HOME/PAUSE"
  printf 'marker-from-agent' > "$S/record-request"; cfg RECORD_SEC=5
  STUB_REC_MAX=1 run record.sh --request
  eq "--request mode reads the marker" 1 "$(find "$Q/control" -name 'done-marker-from-agent-*' | wc -l | tr -d ' ')"
  check "--request mode consumes the request file" test ! -e "$S/record-request"
  end_env
  new_env
  start=$(date +%s)
  ( run record.sh 30 closing-test ) &
  bg=$!
  sleep 2; echo closed > "$STUB_DIR/lid"
  wait "$bg"
  took=$(( $(date +%s) - start ))
  check "lid closed mid-recording: stops early (took ${took}s of 30)" test "$took" -lt 15
  eq "partial recording is kept" 1 "$(nfiles "$Q/recordings")"
  has "partial is logged" "$L/record.log" "stopped early"
  has "done note says partial" "$(first_file "$Q/control")" "partial:   yes"
  end_env
fi

# ============================================================================
if section "events and extras"; then
  new_env
  run trigger.sh interval
  has "interval shot writes a heartbeat" "$L/events.log" "HEARTBEAT battery=87% power=AC wifi=on"
  run trigger.sh space
  eq "other reasons don't write heartbeats" 1 "$(grep -c HEARTBEAT "$L/events.log")"
  run upload.sh
  echo Battery > "$STUB_DIR/power"; run upload.sh
  has "charger unplugged is logged" "$L/events.log" "POWER: AC -> Battery (charger unplugged)"
  echo AC > "$STUB_DIR/power"; run upload.sh
  has "plugged back in is logged" "$L/events.log" "POWER: Battery -> AC"
  end_env
  new_env
  run upload.sh
  hasnt "KEEP_AWAKE=0: no caffeinate" "$STUB_DIR/calls" caffeinate
  cfg KEEP_AWAKE=1; run upload.sh; sleep 0.3
  has "KEEP_AWAKE=1: caffeinate -di with a timeout" "$STUB_DIR/calls" "caffeinate -di -t 180"
  : > "$STUB_DIR/calls"; echo closed > "$STUB_DIR/lid"; run upload.sh; sleep 0.3
  hasnt "lid closed: no caffeinate" "$STUB_DIR/calls" caffeinate
  end_env
  new_env
  cfg INTERVAL_SEC=banana; cfg MAX_WIDTH=
  run trigger.sh space
  eq "garbage in config.env falls back to defaults" 1 "$(nshots)"
  end_env
fi

if section "status"; then
  new_env
  run trigger.sh space
  run status.sh > "$T/s.txt"
  has "shows last capture" "$T/s.txt" "last capture"
  has "shows queue" "$T/s.txt" "1 file(s)"
  touch "$MW_HOME/PAUSE"; run status.sh > "$T/s.txt"
  has "shows PAUSED" "$T/s.txt" "PAUSED"
  end_env
fi

# ============================================================================
if section "install / uninstall"; then
  new_env
  export STUB_DARWIN=1 MW_LAUNCH_AGENTS_DIR=$T/LaunchAgents
  cfg INTERVAL_SEC=420; cfg CONTROL_POLL_SEC=45
  run install.sh > "$T/inst.txt" 2>&1; eq "install exits 0" 0 $?
  for a in capture upload record; do check "plist $a exists" test -f "$T/LaunchAgents/com.macwatch.$a.plist"; done
  pl() { python3 -c '
import plistlib,sys
d=plistlib.load(open(sys.argv[1],"rb"))
print(eval(sys.argv[2]))' "$T/LaunchAgents/com.macwatch.$1.plist" "$2"; }
  eq "capture: valid plist, StartInterval from config" 420 "$(pl capture "d['StartInterval']")"
  eq "capture: RunAtLoad" True "$(pl capture "d['RunAtLoad']")"
  eq "capture: runs trigger.sh interval via /bin/sh" "/bin/sh $ROOT/bin/trigger.sh interval" "$(pl capture "' '.join(d['ProgramArguments'])")"
  eq "upload: StartInterval from CONTROL_POLL_SEC" 45 "$(pl upload "d['StartInterval']")"
  eq "upload: WatchPaths on SystemConfiguration" "['/Library/Preferences/SystemConfiguration/']" "$(pl upload "d['WatchPaths']")"
  eq "upload: AbandonProcessGroup" True "$(pl upload "d['AbandonProcessGroup']")"
  eq "record: on-demand only (no schedule)" "False" "$(pl record "d['RunAtLoad']")"
  eq "record: --request" "/bin/sh $ROOT/bin/record.sh --request" "$(pl record "' '.join(d['ProgramArguments'])")"
  has "logs go to log/" "$T/LaunchAgents/com.macwatch.capture.plist" "$MW_HOME/log/launchd-capture.log"
  has "uses launchctl bootstrap gui/UID" "$STUB_DIR/calls" "launchctl bootstrap gui/$(id -u) $T/LaunchAgents/com.macwatch.capture.plist"
  has "install output mentions Background Items" "$T/inst.txt" "Background Items"
  has "install output says autostart is at LOGIN" "$T/inst.txt" "LOG IN"
  has "install output explains Screen Recording" "$T/inst.txt" "Screen & System Audio Recording"
  has "install output shows the PAUSE kill switch" "$T/inst.txt" "touch $MW_HOME/PAUSE"
  run install.sh > /dev/null 2>&1; eq "install is idempotent" 0 $?
  eq "still exactly three plists" 3 "$(ls "$T/LaunchAgents" | wc -l | tr -d ' ')"
  echo x > "$Q/keep.jpg"
  run uninstall.sh > "$T/un.txt" 2>&1; eq "uninstall exits 0" 0 $?
  eq "uninstall removes the plists" 0 "$(ls "$T/LaunchAgents" | wc -l | tr -d ' ')"
  has "uninstall boots the agents out" "$STUB_DIR/calls" "launchctl bootout gui/$(id -u)/com.macwatch.upload"
  check "uninstall keeps queued data" test -f "$Q/keep.jpg"
  check "uninstall keeps config.env" test -f "$MW_HOME/config.env"
  echo y | $SH "$ROOT/bin/uninstall.sh" --purge > /dev/null 2>&1
  check "--purge (confirmed) deletes the queue" test ! -d "$Q"
  check "--purge keeps config.env" test -f "$MW_HOME/config.env"
  unset STUB_DARWIN MW_LAUNCH_AGENTS_DIR
  end_env
  new_env
  run install.sh > "$T/x.txt" 2>&1
  check "install refuses on non-macOS" test $? -ne 0
  end_env
fi

if section "diagnose and selftest"; then
  new_env
  mkdir -p "$T/fakecfg"; echo 'token = {"access_token":"ya29.SHOULDNEVERAPPEAR000"}' > "$STUB_DIR/rclone.conf"; chmod 600 "$STUB_DIR/rclone.conf"
  run trigger.sh space
  run diagnose.sh > "$T/d.txt" 2>&1; eq "diagnose exits 0" 0 $?
  has "diagnose: macOS version" "$T/d.txt" "26.6.2"
  has "diagnose: lid state" "$T/d.txt" "lid"
  hasnt "diagnose never prints rclone config secrets" "$T/d.txt" "SHOULDNEVERAPPEAR"
  STUB_REC_MAX=2 SELFTEST_AUTO=1 run selftest.sh > "$T/st.txt" 2>&1
  has "selftest prints PASS lines" "$T/st.txt" "PASS"
  hasnt "selftest (stubs, auto-answers) has no FAIL" "$T/st.txt" "FAIL"
  hasnt "selftest never prints rclone config secrets" "$T/st.txt" "SHOULDNEVERAPPEAR"
  end_env
fi

if command -v lua5.4 >/dev/null 2>&1 || command -v lua >/dev/null 2>&1; then
  if section "hammerspoon (lua, fake hs)"; then
    LUA=$(command -v lua5.4 || command -v lua)
    if "$LUA" "$ROOT/tests/hs_mock.lua" "$ROOT/hammerspoon/init.lua" > "${TMPDIR:-/tmp}/mw-hs.out" 2>&1; then
      ok "hammerspoon/init.lua behaves and only ever reads the key code ($(grep -c '  ok' "${TMPDIR:-/tmp}/mw-hs.out") checks)"
    else
      bad "hammerspoon/init.lua mock test" "$(grep FAIL "${TMPDIR:-/tmp}/mw-hs.out" | head -n 3; tail -n 3 "${TMPDIR:-/tmp}/mw-hs.out")"
    fi
  fi
fi

# ============================================================================
# Integration with the REAL rclone (local backend standing in for Drive), when installed.
if [ -n "$REAL_RCLONE" ] && section "real rclone (local backend)"; then
  new_env
  RB=$T/realbin; mkdir -p "$RB"
  for s in "$ROOT"/tests/stubs/*; do [ "${s##*/}" = rclone ] || ln -s "$s" "$RB/${s##*/}"; done
  ln -s "$REAL_RCLONE" "$RB/rclone"
  PATH=$RB:$ORIG_PATH; export PATH
  export RCLONE_CONFIG=$T/rclone.conf RCLONE_CONFIG_TESTREMOTE_TYPE=local
  cfg RCLONE_REMOTE=testremote; cfg "DRIVE_FOLDER=$T/realdrive"
  RD=$T/realdrive
  mkdir -p "$RD/control/snap-now"                       # folder marker, fresh
  mkdir -p "$RD/control/record-5min"; old "$RD/control/record-5min"   # stale folder marker
  : > "$RD/control/Snap-Now.txt"                         # file marker
  run trigger.sh space
  mkdir -p "$S"; now_s=$(date +%s); echo "$now_s" > "$S/last-prune"
  find "$Q" -type f -exec touch -t 202001010000 {} \;   # real rclone really honours --min-age 15s
  PRUNE_EVERY_SEC=99999 SETTLE_SEC=16 run upload.sh   # (no prune yet: the aged mtime would count as old)
  eq "real rclone: both fresh markers fired (debounced to one shot) + space shot" 2 "$(find "$RD/shots" -name '*.jpg' | wc -l | tr -d ' ')"
  check "real rclone: remote shot exists" test "$(find "$RD/shots" -name '*-remote.jpg' | wc -l | tr -d ' ')" = 1
  eq "real rclone: all marker names gone" 0 "$(find "$RD/control" -mindepth 1 | wc -l | tr -d ' ')"
  hasnt "real rclone: stale record marker did not start a recording" "$STUB_DIR/calls" "kickstart"
  eq "real rclone: local queue empty" 0 "$(nfiles "$Q")"
  has "real rclone: stale marker logged as not acted on" "$L/upload.log" "record-5min"
  mkdir -p "$RD/shots/2020-01-01"; echo o > "$RD/shots/2020-01-01/o.jpg"; old "$RD/shots/2020-01-01/o.jpg"
  run upload.sh
  check "real rclone: prune removes old files" test ! -f "$RD/shots/2020-01-01/o.jpg"
  check "real rclone: prune removes the empty date folder" test ! -d "$RD/shots/2020-01-01"
  hasnt "real rclone: no ERROR in upload.log" "$L/upload.log" "ERROR"
  end_env
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAILN"
[ "$FAILN" -eq 0 ]
