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
  echo "UPLOAD_EVERY_SEC=0" >> "$MW_HOME/config.env"   # the batching test sets it back
  PATH=$ROOT/tests/stubs:$ORIG_PATH
  export PATH
  # fast internals
  export UPLOAD_EVERY_SEC=0 PRUNE_EVERY_SEC=0 SETTLE_SEC=0 WATCHDOG_POLL_SEC=1 STOP_GRACE_SEC=1
  unset STUB_DARWIN STUB_REC_MAX STUB_WIDTH
  Q=$MW_HOME/queue; D=$STUB_RCLONE_ROOT/bucket; L=$MW_HOME/log; S=$MW_HOME/state
  cfg "B2_BUCKET=bucket"; cfg "WORKER_URL="     # no Worker unless a test starts the fake one
  WPID=
  TODAY=$(date +%Y-%m-%d)
}
end_env() { [ -n "${WPID:-}" ] && kill "$WPID" 2>/dev/null; WPID=; rm -rf "$T"; }

# The real Worker code on localhost (tests/fake_worker.mjs). The Mac scripts reach it with
# real curl; its "B2" is the same folder the fake rclone uploads into ($D).
REAL_CURL=$(command -v curl 2>/dev/null)    # evaluated before the stubs go on PATH
start_worker() {
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$MW_HOME/.mac-token"; chmod 600 "$MW_HOME/.mac-token"
  TOKEN=$(cat "$MW_HOME/.mac-token")
  _h=$(printf '%s' "$TOKEN" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)
  mkdir -p "$D"
  node "$ROOT/tests/fake_worker.mjs" "$T/port" "$D" "$_h" > "$T/worker.log" 2>&1 &
  WPID=$!
  _i=0; while [ ! -s "$T/port" ] && [ "$_i" -lt 100 ]; do sleep 0.1; _i=$((_i + 1)); done
  WURL=http://127.0.0.1:$(cat "$T/port")
  cfg "WORKER_URL=$WURL"
}
wk() { "$REAL_CURL" -s -X POST --data-binary "$2" "$WURL/__test/$1"; }      # test control: cmd, settings, kv
dump() { "$REAL_CURL" -s "$WURL/__test/dump"; }
py() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
cfg() { printf '%s\n' "$1" >> "$MW_HOME/config.env"; }   # later lines win
run() { _s=$1; shift; $SH "$ROOT/bin/$_s" "$@"; }
nfiles() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }
nshots() { nfiles "$Q/shots"; }
first_file() { find "$1" -type f 2>/dev/null | sort | head -n 1; }
old() { touch -t 202001010000 "$1"; }

section() { printf '\n== %s\n' "$1"; _skip=0; case $1 in *"$FILTER"*) ;; *) _skip=1 ;; esac; [ "$_skip" = 0 ]; }

ORIG_PATH=$PATH
ORIG_HOME=$HOME

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
  hasnt "narrow screen is never enlarged" "$STUB_DIR/calls" "resampleWidth 1440"
  has "a 320 px thumbnail is made" "$STUB_DIR/calls" "resampleWidth 320"
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

if section "enter: every press"; then
  new_env
  run trigger.sh enter; run trigger.sh enter; run trigger.sh enter
  eq "three Enter triggers in the same second: three shots (no cooldown)" 3 "$(nshots)"
  eq "...with three different names" 3 "$(find "$Q/shots" -name '*-enter*.jpg' | sed 's|.*/||' | sort -u | wc -l | tr -d ' ')"
  eq "...and three thumbnails" 3 "$(nfiles "$Q/thumbs")"
  rm -rf "$Q"
  for _ in 1 2 3 4 5 6; do run trigger.sh enter & done; wait
  eq "six Enter shots at the same moment: none lost or overwritten" 6 "$(nshots)"
  cfg ENTER_MIN_GAP_SEC=60; rm -rf "$Q"
  run trigger.sh enter; run trigger.sh enter
  eq "ENTER_MIN_GAP_SEC still works if you want a cooldown" 1 "$(nshots)"
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
  check "online: file is in the bucket shots/DATE/" test -f "$D/shots/$TODAY/$fname"
  check "online: its thumbnail is in thumbs/DATE/" test -f "$D/thumbs/$TODAY/$fname"
  check "online: last-upload-ok recorded" test -s "$S/last-upload-ok"
  check "online: queue root still exists" test -d "$Q"
  rm -rf "$D"
  touch "$STUB_DIR/offline"
  run trigger.sh wake; run trigger.sh lock
  run upload.sh; eq "offline: exit 0" 0 $?
  eq "offline: files stay queued" 2 "$(nshots)"
  check "offline: nothing created in the bucket" test ! -d "$D/shots"
  hasnt "offline: no ERROR logged" "$L/upload.log" "ERROR"
  rm "$STUB_DIR/offline"
  run upload.sh
  eq "back online: queue drains" 0 "$(nfiles "$Q")"
  eq "back online: both files in the bucket" 2 "$(nfiles "$D/shots")"
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
  mkdir -p "$Q/other"; echo c > "$Q/other/x.jpg"
  run upload.sh
  check "jpg goes to shots/DATE/" test -f "$D/shots/$TODAY/20261113-100000-interval.jpg"
  check "mov goes to recordings/DATE/" test -f "$D/recordings/$TODAY/20261113-100000-rec.mov"
  check "only shots/thumbs/recordings are uploaded" test -f "$Q/other/x.jpg" -a ! -e "$D/other"
  has "one rclone call for all kinds, no destination listing" "$STUB_DIR/rclone_calls" "move .*--no-check-dest.*--include /shots/\*\*"
  hasnt "nothing is ever deleted in the bucket by the Mac" "$STUB_DIR/rclone_calls" " delete"
  end_env
fi

if section "upload: loud auth failures, no secrets in logs"; then
  new_env
  run trigger.sh space
  echo '1|Failed to create file system: failed to authorize account: Unauthorized: unauthorized (401) application_key=K005SUPERSECRETVALUE12345' > "$STUB_DIR/rclone_fail"
  run upload.sh
  has "ERROR line in upload.log" "$L/upload.log" "ERROR"
  has "auth hint tells you the fix" "$L/upload.log" "setup-remote.sh"
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

if section "batching"; then
  new_env
  cfg UPLOAD_EVERY_SEC=300
  run trigger.sh space; run upload.sh
  eq "first run uploads (nothing was sent yet)" 0 "$(nshots)"
  run trigger.sh wake; run upload.sh
  eq "within the batch window: shot waits in the queue" 1 "$(nshots)"
  eq "...and no rclone move was attempted" 1 "$(grep -c ' move ' "$STUB_DIR/rclone_calls")"
  run trigger.sh lock; run trigger.sh unlock
  echo 1000 > "$S/last-flush"; run upload.sh
  eq "after the window: the whole batch goes at once" 0 "$(nshots)"
  eq "...in 4 files" 4 "$(nfiles "$D/shots")"
  end_env
  new_env
  cfg UPLOAD_EVERY_SEC=300
  run trigger.sh space; run upload.sh; run trigger.sh wake
  touch "$STUB_DIR/offline"; run upload.sh
  rm "$STUB_DIR/offline"; run upload.sh
  eq "network back: backlog uploaded immediately, not after the window" 0 "$(nshots)"
  end_env
  new_env
  cfg UPLOAD_EVERY_SEC=300
  run trigger.sh space; run upload.sh; run trigger.sh wake
  run upload.sh --now
  eq "upload.sh --now (after Screenshot now) ignores the batch window" 0 "$(nshots)"
  end_env
fi

if section "remote settings are live"; then
  new_env
  echo "INTERVAL_SEC=60" > "$S/../home/state/remote.conf" 2>/dev/null || { mkdir -p "$S"; echo "INTERVAL_SEC=60" > "$S/remote.conf"; }
  mkdir -p "$S"; echo "INTERVAL_SEC=60" > "$S/remote.conf"
  echo $(( $(date +%s) - 100 )) > "$S/last-trigger-interval"
  run trigger.sh interval
  eq "INTERVAL_SEC=60 from the web page: a shot 100 s after the last one" 1 "$(nshots)"
  rm "$S/remote.conf"; echo $(( $(date +%s) - 100 )) > "$S/last-trigger-interval"
  run trigger.sh interval
  eq "INTERVAL_SEC=300 (config.env): 100 s is too soon" 1 "$(nshots)"
  end_env
fi

if section "status.json"; then
  new_env
  run trigger.sh space
  printf '%s\n' '1 something "quoted" \ back\slash failed' > "$S/error-capture"
  run report.sh
  python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d["lid"]=="open" and d["paused"]=="no", d
assert d["lastCapture"]["reason"]=="space" and d["lastCapture"]["result"]=="ok", d
assert isinstance(d["updated"],int) and d["battery"]=="87%" and d["power"]=="AC", d
assert "quoted" in d["errors"] and chr(34) not in d["errors"] and chr(92) not in d["errors"], d
assert d["queue"]==2 and d["localShots"]==1 and isinstance(d["queueMB"],float) and (d["diskFreeGB"] is None or d["diskFreeGB"]>=0), d
' "$S/status.json" && ok "status.json is valid JSON with the expected fields (disk, queue); quotes/backslashes cannot break it" || bad "status.json content"
  hasnt "status.json has no screen content or secrets" "$S/status.json" "token"
  end_env
fi

if section "hammerspoon watchdog"; then
  new_env
  run upload.sh
  hasnt "not enabled: Hammerspoon is left alone" "$STUB_DIR/calls" "open -g -a Hammerspoon"
  : > "$S/hammerspoon-enabled"
  run upload.sh
  has "enabled and not running: it is started" "$STUB_DIR/calls" "open -g -a Hammerspoon"
  : > "$STUB_DIR/calls"; : > "$STUB_DIR/hs_running"
  run upload.sh
  hasnt "enabled and running: nothing to do" "$STUB_DIR/calls" "open -g -a Hammerspoon"
  run status.sh > "$T/s.txt"; has "status shows Hammerspoon running" "$T/s.txt" "hammerspoon .*running"
  end_env
  new_env
  export STUB_DARWIN=1 MW_LAUNCH_AGENTS_DIR=$T/LaunchAgents HOME=$T/fakehome
  mkdir -p "$HOME"
  echo n | $SH "$ROOT/bin/install.sh" --hammerspoon > "$T/i.txt" 2>&1
  check "--hammerspoon: login agent plist written" test -f "$T/LaunchAgents/com.macwatch.hammerspoon.plist"
  check "--hammerspoon: watchdog flag set" test -e "$S/hammerspoon-enabled"
  eq "hammerspoon agent opens the app at login" "/usr/bin/open -g -a Hammerspoon" "$(python3 -c '
import plistlib,sys
d=plistlib.load(open(sys.argv[1],"rb")); print(" ".join(d["ProgramArguments"]), d["RunAtLoad"] and "", end="")' "$T/LaunchAgents/com.macwatch.hammerspoon.plist" | sed 's/ *$//')"
  check "declining the init.lua edit leaves ~/.hammerspoon alone" test ! -e "$HOME/.hammerspoon/init.lua"
  run install.sh >/dev/null 2>&1
  check "plain re-install keeps the agent (flag remembered)" test -f "$T/LaunchAgents/com.macwatch.hammerspoon.plist"
  run install.sh --no-hammerspoon >/dev/null 2>&1
  check "--no-hammerspoon removes agent and flag" test ! -e "$T/LaunchAgents/com.macwatch.hammerspoon.plist" -a ! -e "$S/hammerspoon-enabled"
  unset STUB_DARWIN MW_LAUNCH_AGENTS_DIR
  HOME=$ORIG_HOME; export HOME
  end_env
fi

if section "rate limit backoff"; then
  new_env
  run trigger.sh space
  echo '1|b2 upload: too_many_requests (429): slow down' > "$STUB_DIR/rclone_fail"
  run upload.sh
  check "rate limit: backoff stamp written" test -s "$S/backoff-until"
  has "rate limit: hint says what happens" "$L/upload.log" "slow down"
  rm "$STUB_DIR/rclone_fail"; : > "$STUB_DIR/rclone_calls"
  run upload.sh
  eq "during backoff: rclone is not called at all" 0 "$(wc -l < "$STUB_DIR/rclone_calls" | tr -d ' ')"
  eq "during backoff: file stays queued" 1 "$(nshots)"
  echo 1000 > "$S/backoff-until"
  run upload.sh
  eq "after backoff: uploads again" 0 "$(nshots)"
  check "after a clean run the error flag is gone" test ! -f "$S/error-upload"
  end_env
  new_env
  run trigger.sh space
  echo "1|boom: something transient" > "$STUB_DIR/rclone_fail"
  run upload.sh
  check "transient error flagged" test -f "$S/error-upload"
  rm "$STUB_DIR/rclone_fail"; run upload.sh
  check "the next clean run clears the flag" test ! -f "$S/error-upload"
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

# ============================================================================
if section "listen: commands from the web page"; then
  new_env; start_worker
  run listen.sh --once
  eq "idle poll: nothing captured" 0 "$(nshots)"
  eq "poll reached the Worker" ok "$(cat "$S/worker-reach")"
  eq "the Worker saw the Mac (paused=no)" no "$(dump | py 'json.loads(d["kv"]["mac"])["paused"]')"
  eq "status.json posted on the first poll" open "$(dump | py 'json.loads(d["kv"]["status_json"])["lid"]')"
  hasnt "the Mac token never appears in curl arguments" "$STUB_DIR/curl_calls" "$TOKEN"
  id=$(wk cmd snap)
  run listen.sh --once
  eq "snap: one remote shot in the bucket" 1 "$(find "$D/shots" -name '*-remote.jpg' | wc -l | tr -d ' ')"
  eq "snap: its thumbnail too" 1 "$(find "$D/thumbs" -name '*-remote.jpg' | wc -l | tr -d ' ')"
  eq "snap: sent at once, queue empty" 0 "$(nfiles "$Q")"
  eq "snap: the Worker indexed shot + thumbnail" 2 "$(dump | py 'len([f for f in d["files"] if f["key"].endswith("-remote.jpg")])')"
  eq "snap: command acked" 1 "$(dump | py 'len([c for c in d["commands"] if c["acked"]])')"
  eq "last handled id remembered" "$id" "$(cat "$S/last-cmd")"
  id=$(wk cmd snap); echo "$id" > "$S/last-cmd"; rm -f "$S/last-trigger-remote"
  run listen.sh --once
  eq "at most once: an id already handled (ack lost) is not run again" 1 "$(find "$D/shots" -name '*-remote.jpg' | wc -l | tr -d ' ')"
  eq "...but it is acked" 0 "$(dump | py 'len([c for c in d["commands"] if not c["acked"]])')"
  wk cmd "snap 7200" >/dev/null
  run listen.sh --once
  eq "command older than MARKER_MAX_AGE_MIN: not acted on" 1 "$(find "$D/shots" -name '*-remote.jpg' | wc -l | tr -d ' ')"
  has "stale command is logged" "$L/listen.log" "not acted on"
  eq "stale command acked anyway" 0 "$(dump | py 'len([c for c in d["commands"] if not c["acked"]])')"
  wk cmd pause >/dev/null; run listen.sh --once
  check "pause: remote-paused state set" test -e "$S/remote-paused"
  run listen.sh --once
  eq "paused: the next poll tells the Worker" remote "$(dump | py 'json.loads(d["kv"]["mac"])["paused"]')"
  wk cmd snap >/dev/null; rm -f "$S/last-trigger-remote"; run listen.sh --once
  eq "paused: snap is ignored" 1 "$(find "$D/shots" "$Q" -name '*-remote.jpg' | wc -l | tr -d ' ')"
  has "paused: logged" "$L/listen.log" "ignored because capturing is paused remotely"
  run trigger.sh space
  eq "paused: nothing captures" 0 "$(nshots)"
  mkdir -p "$Q/shots/$TODAY"; echo x > "$Q/shots/$TODAY/20261113-100000-interval.jpg"
  run upload.sh --now; eq "paused: no uploads" 1 "$(nshots)"
  rm -rf "$Q/shots"
  wk cmd resume >/dev/null; run listen.sh --once
  check "resume: pause lifted" test ! -e "$S/remote-paused"
  wk cmd "pause 99999" >/dev/null; run listen.sh --once
  check "an old pause still pauses (the safe direction)" test -e "$S/remote-paused"
  wk cmd "resume 99999" >/dev/null; run listen.sh --once
  check "an old resume still resumes" test ! -e "$S/remote-paused"
  id=$(wk cmd record); run listen.sh --once
  has "record: the record agent is kickstarted" "$STUB_DIR/calls" "kickstart gui/.*/com.macwatch.record"
  eq "record: label handed over" "cmd-$id" "$(cat "$S/record-request")"
  rm -f "$S/record-request"; : > "$STUB_DIR/calls"; mkdir -p "$S/record.lock"
  wk cmd record >/dev/null; run listen.sh --once
  hasnt "recording already running: no second kickstart" "$STUB_DIR/calls" "kickstart"
  rm -rf "$S/record.lock"; touch "$STUB_DIR/launchctl_fail"; wk cmd record >/dev/null; run listen.sh --once
  check "kickstart failure is an error flag" test -f "$S/error-record"
  rm "$STUB_DIR/launchctl_fail"
  end_env
fi

if section "listen: settings, fast mode, live, failures"; then
  new_env; start_worker
  wk settings '{"INTERVAL_SEC":120,"JPEG_QUALITY":10,"STORAGE_SOFT_LIMIT_GB":5}' >/dev/null
  run listen.sh --once
  eq "set lines applied (Worker-only settings are not sent)" "INTERVAL_SEC=120 JPEG_QUALITY=10" "$(tr '\n' ' ' < "$S/remote.conf" | sed 's/ $//')"
  run trigger.sh space
  has "applied setting is really used (JPEG_QUALITY=10)" "$STUB_DIR/calls" "formatOptions 10 "
  wk settings '{"KEEP_AWAKE":5,"INTERVAL_SEC":"$(touch /tmp/mw-injected)","MAX_WIDTH":800}' >/dev/null
  run listen.sh --once
  eq "the Mac re-checks every value (out of range, text): only MAX_WIDTH=800 kept" "MAX_WIDTH=800" "$(cat "$S/remote.conf")"
  check "shell injection through a setting did nothing" test ! -e /tmp/mw-injected
  has "result logged" "$L/listen.log" "applied=1 rejected=2"
  wk settings '{}' >/dev/null; run listen.sh --once
  check "no set lines: back to config.env" test ! -e "$S/remote.conf"
  eq "normal polling every POLL_SLOW_SEC" 20 "$(cat "$S/poll-interval")"
  wk kv "watching_until +600" >/dev/null; run listen.sh --once
  eq "page open (fast 1): polling every POLL_FAST_SEC" 2 "$(cat "$S/poll-interval")"
  wk kv "live_until +600" >/dev/null; : > "$STUB_DIR/calls"; run listen.sh --once
  eq "live 1: one small frame uploaded to live/" 1 "$(nfiles "$D/live")"
  has "live frame is 640 px wide, quality 40" "$STUB_DIR/calls" "resampleWidth 640 -s format jpeg -s formatOptions 40"
  case $(dump | py 'json.loads(d["kv"]["live_key"])["key"]') in live/*.jpg) ok "live frame registered with the Worker" ;; *) bad "live frame registered" ;; esac
  run listen.sh --once
  eq "live frames at most every LIVE_EVERY_SEC" 1 "$(nfiles "$D/live")"
  : > "$STUB_DIR/curl_calls"; touch "$MW_HOME/PAUSE"; run listen.sh --once
  eq "PAUSE file: no network at all" 0 "$(grep -c . "$STUB_DIR/curl_calls")"
  rm "$MW_HOME/PAUSE"; echo closed > "$STUB_DIR/lid"; run listen.sh --once
  eq "lid closed: no polling" 0 "$(grep -c . "$STUB_DIR/curl_calls")"
  echo open > "$STUB_DIR/lid"
  good=$(cat "$MW_HOME/.mac-token"); printf '%064d' 7 > "$MW_HOME/.mac-token"
  run listen.sh --once
  check "wrong token: error flag" test -f "$S/error-listen"
  has "wrong token: the fix is in the log" "$L/listen.log" "put-secrets.sh MAC_TOKEN_HASH"
  run status.sh > "$T/s.txt"; has "status.sh shows the Worker refusing" "$T/s.txt" "REFUSING"
  printf '%s' "$good" > "$MW_HOME/.mac-token"; run listen.sh --once
  check "token fixed: error cleared" test ! -f "$S/error-listen"
  touch "$STUB_DIR/worker_down"; run listen.sh --once; run listen.sh --once
  check "Worker unreachable: no error flag (just offline)" test ! -f "$S/error-listen"
  eq "...logged once" 1 "$(grep -c 'cannot reach the Worker' "$L/listen.log")"
  rm "$STUB_DIR/worker_down"; rm "$MW_HOME/.mac-token"; run listen.sh --once
  has "no token: says to run setup-remote.sh" "$S/error-listen" "setup-remote.sh"
  for f in "$L"/*.log; do hasnt "token never logged ($(basename "$f"))" "$f" "$good"; done
  end_env
  new_env; start_worker
  mkdir -p "$S/listen.lock"; echo $$ > "$S/listen.lock/pid"
  run listen.sh --once
  check "a second listen.sh does not start while one runs" test ! -e "$S/worker-reach"
  end_env
fi

if section "upload: index reported to the Worker"; then
  new_env; start_worker
  run trigger.sh space; run upload.sh
  eq "uploaded shot + thumbnail are indexed" 2 "$(dump | py 'len(d["files"])')"
  check "nothing left pending" test ! -s "$S/index-pending"
  rm -f "$S/last-trigger-wake"; run trigger.sh wake; touch "$STUB_DIR/worker_down"; run upload.sh
  eq "Worker unreachable: the upload still happens" 0 "$(nshots)"
  eq "...and the index lines are kept for later" 2 "$(grep -c . "$S/index-pending")"
  has "...logged" "$L/upload.log" "will retry"
  rm "$STUB_DIR/worker_down"; run upload.sh
  eq "next run reports them" 4 "$(dump | py 'len(d["files"])')"
  check "pending file gone" test ! -s "$S/index-pending"
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
  export MW_NO_UPLOAD=1     # keep recordings in the queue so the tests can look at them
  new_env
  STUB_REC_MAX=1 run record.sh 3 record-5min
  f=$(first_file "$Q/recordings")
  case $f in */recordings/$TODAY/*-rec.mov) ok "recording queued as ...-rec.mov under recordings/DATE/" ;; *) bad "recording location" "$f" ;; esac
  has "recorded with -v -V N, no audio flag" "$STUB_DIR/calls" "screencapture -v -V 3 -x"
  hasnt "never asks for audio" "$STUB_DIR/calls" " -g"
  has "compressed with avconvert preset" "$STUB_DIR/calls" "avconvert --preset Preset1280x720"
  eq "compressed copy is what is queued" 10 "$(wc -c < "$f" | tr -d ' ')"
  has "the label is logged" "$L/record.log" "(record-5min)"
  check "tmp/ clean afterwards" test "$(nfiles "$MW_HOME/tmp")" = 0
  check "lock released" test ! -d "$S/record.lock"
  end_env
  new_env
  touch "$STUB_DIR/avconvert_fail"
  STUB_REC_MAX=1 run record.sh 3
  eq "avconvert fails, no ffmpeg: original kept" 1 "$(nfiles "$Q/recordings")"
  has "fallback is logged" "$L/record.log" "keeping the original"
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
  has "--request mode reads the label" "$L/record.log" "(marker-from-agent)"
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
  has "clean INT stop worked even from a background job (perl resets SIGINT)" "$STUB_DIR/calls" "screencapture finished early"
  hasnt "no TERM needed" "$L/record.log" "sent TERM"
  has "log says partial" "$L/record.log" "partial: yes"
  end_env
  unset MW_NO_UPLOAD
  new_env
  STUB_REC_MAX=1 run record.sh 3
  eq "without MW_NO_UPLOAD the recording is uploaded at once" 1 "$(nfiles "$D/recordings")"
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
  has "shows queue (shot + thumbnail)" "$T/s.txt" "2 file(s)"
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
  for a in capture upload record listen; do check "plist $a exists" test -f "$T/LaunchAgents/com.macwatch.$a.plist"; done
  pl() { python3 -c '
import plistlib,sys
d=plistlib.load(open(sys.argv[1],"rb"))
print(eval(sys.argv[2]))' "$T/LaunchAgents/com.macwatch.$1.plist" "$2"; }
  eq "capture: ticks every CONTROL_POLL_SEC (INTERVAL_SEC is checked in trigger.sh, so it is live-tunable)" 45 "$(pl capture "d['StartInterval']")"
  eq "capture: RunAtLoad" True "$(pl capture "d['RunAtLoad']")"
  eq "capture: runs trigger.sh interval via /bin/sh" "/bin/sh $ROOT/bin/trigger.sh interval" "$(pl capture "' '.join(d['ProgramArguments'])")"
  eq "upload: StartInterval from CONTROL_POLL_SEC" 45 "$(pl upload "d['StartInterval']")"
  eq "upload: WatchPaths on SystemConfiguration" "['/Library/Preferences/SystemConfiguration/']" "$(pl upload "d['WatchPaths']")"
  eq "upload: AbandonProcessGroup" True "$(pl upload "d['AbandonProcessGroup']")"
  eq "record: on-demand only (no schedule)" "False" "$(pl record "d['RunAtLoad']")"
  eq "record: --request" "/bin/sh $ROOT/bin/record.sh --request" "$(pl record "' '.join(d['ProgramArguments'])")"
  eq "listen: runs listen.sh" "/bin/sh $ROOT/bin/listen.sh" "$(pl listen "' '.join(d['ProgramArguments'])")"
  eq "listen: KeepAlive + RunAtLoad (always polling while logged in)" "True True 30" "$(pl listen "d['KeepAlive'], d['RunAtLoad'], d['ThrottleInterval']" | tr -d '(),')"
  has "logs go to log/" "$T/LaunchAgents/com.macwatch.capture.plist" "$MW_HOME/log/launchd-capture.log"
  has "uses launchctl bootstrap gui/UID" "$STUB_DIR/calls" "launchctl bootstrap gui/$(id -u) $T/LaunchAgents/com.macwatch.capture.plist"
  has "install output mentions Background Items" "$T/inst.txt" "Background Items"
  has "install output says autostart is at LOGIN" "$T/inst.txt" "LOG IN"
  has "install output explains Screen Recording" "$T/inst.txt" "Screen & System Audio Recording"
  has "install output shows the PAUSE kill switch" "$T/inst.txt" "touch $MW_HOME/PAUSE"
  has "install output says to run setup-remote.sh when there is no token" "$T/inst.txt" "setup-remote.sh"
  run install.sh > /dev/null 2>&1; eq "install is idempotent" 0 $?
  eq "still exactly four plists" 4 "$(ls "$T/LaunchAgents" | wc -l | tr -d ' ')"
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

if section "setup-remote"; then
  new_env; start_worker
  rm "$MW_HOME/.mac-token"; mkdir -p "$D"
  export STUB_REMOTES=none:
  printf 'K005abcdef\nSECRETAPPKEY0123456789\n' | $SH "$ROOT/bin/setup-remote.sh" > "$T/sr.txt" 2>&1
  eq "setup-remote exits 0" 0 $?
  has "rclone b2 remote written" "$STUB_DIR/rclone.conf" "type = b2"
  has "...with the keyID" "$STUB_DIR/rclone.conf" "account = K005abcdef"
  has "...and the key as rclone expects it for b2 (plain, NOT obscured)" "$STUB_DIR/rclone.conf" "key = SECRETAPPKEY0123456789"
  hasnt "the key never appears in rclone's arguments" "$STUB_DIR/rclone_calls" "SECRETAPPKEY"
  if [ -n "$REAL_RCLONE" ]; then
    # the config written above, read by the REAL rclone: it must hand Backblaze exactly this key
    eq "real rclone reads back the same keyID and key" "K005abcdef SECRETAPPKEY0123456789 b2" \
      "$(RCLONE_CONFIG=$STUB_DIR/rclone.conf "$REAL_RCLONE" config dump 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin)["b2"]; print(d["account"], d["key"], d["type"])')"
  fi
  hasnt "the key is never printed" "$T/sr.txt" "SECRETAPPKEY"
  eq "rclone config is chmod 600" "-rw-------" "$(ls -l "$STUB_DIR/rclone.conf" | cut -c1-10)"
  check "a Mac token was created" test -s "$MW_HOME/.mac-token"
  eq ".mac-token is chmod 600" "-rw-------" "$(ls -l "$MW_HOME/.mac-token" | cut -c1-10)"
  hasnt "the token is never printed" "$T/sr.txt" "$(cat "$MW_HOME/.mac-token")"
  h=$(tr -d '\n' < "$MW_HOME/.mac-token" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)
  has "the hash is printed for put-secrets.sh" "$T/sr.txt" "$h"
  has "it says what to do with it" "$T/sr.txt" "put-secrets.sh MAC_TOKEN_HASH"
  unset STUB_REMOTES
  first=$(cat "$MW_HOME/.mac-token")
  $SH "$ROOT/bin/setup-remote.sh" > "$T/sr2.txt" 2>&1 < /dev/null
  eq "running it again keeps the token" "$first" "$(cat "$MW_HOME/.mac-token")"
  has "...and keeps the rclone remote" "$T/sr2.txt" "already exists"
  end_env
fi

if section "diagnose and selftest"; then
  new_env; start_worker
  mkdir -p "$T/fakecfg"; echo 'token = {"access_token":"ya29.SHOULDNEVERAPPEAR000"}' > "$STUB_DIR/rclone.conf"; chmod 600 "$STUB_DIR/rclone.conf"
  run trigger.sh space
  run diagnose.sh > "$T/d.txt" 2>&1; eq "diagnose exits 0" 0 $?
  has "diagnose: macOS version" "$T/d.txt" "26.6.2"
  has "diagnose: lid state" "$T/d.txt" "lid"
  hasnt "diagnose never prints rclone config secrets" "$T/d.txt" "SHOULDNEVERAPPEAR"
  has "diagnose: Worker poll works" "$T/d.txt" "poll with the Mac token: HTTP 200"
  hasnt "diagnose never prints the Mac token" "$T/d.txt" "$TOKEN"
  STUB_REC_MAX=2 SELFTEST_AUTO=1 run selftest.sh > "$T/st.txt" 2>&1
  has "selftest prints PASS lines" "$T/st.txt" "PASS"
  hasnt "selftest (stubs, auto-answers) has no FAIL" "$T/st.txt" "FAIL"
  hasnt "selftest never prints rclone config secrets" "$T/st.txt" "SHOULDNEVERAPPEAR"
  has "selftest checked the Worker" "$T/st.txt" "the Worker accepts this Mac"
  hasnt "selftest never prints the Mac token" "$T/st.txt" "$TOKEN"
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

if command -v node >/dev/null 2>&1; then
  if section "worker (node: core, auth, purge, B2 client)"; then
    if node "$ROOT/tests/worker_test.mjs" > "${TMPDIR:-/tmp}/mw-worker.out" 2>&1; then
      ok "worker: $(grep -c '  ok' "${TMPDIR:-/tmp}/mw-worker.out") checks"
    else
      bad "worker tests" "$(grep FAIL "${TMPDIR:-/tmp}/mw-worker.out" | head -n 5; tail -n 3 "${TMPDIR:-/tmp}/mw-worker.out")"
    fi
  fi
  if section "web page (node)"; then
    if node "$ROOT/tests/web_test.js" > "${TMPDIR:-/tmp}/mw-web.out" 2>&1; then
      ok "web page: logic, API client and page wiring ($(grep -c '  ok' "${TMPDIR:-/tmp}/mw-web.out") checks)"
    else
      bad "web dashboard tests" "$(grep FAIL "${TMPDIR:-/tmp}/mw-web.out" | head -n 3; tail -n 3 "${TMPDIR:-/tmp}/mw-web.out")"
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
  cfg RCLONE_REMOTE=testremote; cfg "B2_BUCKET=$T/realbucket"
  RD=$T/realbucket; mkdir -p "$RD"
  run trigger.sh space
  mkdir -p "$Q/other"; echo x > "$Q/other/not-ours.jpg"
  run upload.sh --now
  eq "real rclone: shot uploaded with the include filters" 1 "$(find "$RD/shots" -name '*-space.jpg' | wc -l | tr -d ' ')"
  eq "real rclone: thumbnail uploaded" 1 "$(find "$RD/thumbs" -name '*-space.jpg' | wc -l | tr -d ' ')"
  check "real rclone: other folders are not uploaded" test ! -e "$RD/other" -a -f "$Q/other/not-ours.jpg"
  eq "real rclone: index lines kept for the Worker (no Worker configured)" 2 "$(grep -c . "$S/index-pending")"
  hasnt "real rclone: no ERROR in upload.log" "$L/upload.log" "ERROR"
  run trigger.sh wake; run upload.sh
  eq "real rclone: batch mode keeps a fresh shot (min-age 15s)" 1 "$(nshots)"
  # archive-pull against the same fake bucket
  mkdir -p "$RD/keep/2026-11-01" "$RD/shots/2026-11-02"
  echo kept > "$RD/keep/2026-11-01/a.jpg"; echo shot > "$RD/shots/2026-11-02/b.jpg"
  AR=$T/archive
  run archive-pull.sh --dest "$AR" > "$T/ar.txt" 2>&1
  check "archive-pull: keep/ copied" test -f "$AR/keep/2026-11-01/a.jpg"
  check "archive-pull: shots NOT copied without --all" test ! -e "$AR/shots"
  has "archive-pull: says it verified" "$T/ar.txt" "verified"
  run archive-pull.sh --dest "$AR" --all > /dev/null 2>&1
  check "archive-pull --all: shots copied" test -f "$AR/shots/2026-11-02/b.jpg"
  check "archive-pull: bucket untouched without --free-remote" test -f "$RD/keep/2026-11-01/a.jpg" -a -f "$RD/shots/2026-11-02/b.jpg"
  rm -f "$AR/keep/2026-11-01/a.jpg"
  run archive-pull.sh --dest "$AR" --dry-run > /dev/null 2>&1
  check "archive-pull --dry-run copies nothing" test ! -e "$AR/keep/2026-11-01/a.jpg"
  echo no | $SH "$ROOT/bin/archive-pull.sh" --dest "$AR" --all --free-remote > /dev/null 2>&1
  check "--free-remote: answering anything but 'delete' keeps the bucket intact" test -f "$RD/keep/2026-11-01/a.jpg"
  echo delete | $SH "$ROOT/bin/archive-pull.sh" --dest "$AR" --all --free-remote > /dev/null 2>&1
  check "--free-remote + delete: verified files removed from the bucket" test ! -e "$RD/keep/2026-11-01/a.jpg" -a ! -e "$RD/shots/2026-11-02/b.jpg"
  check "--free-remote: the copies are still here" test -f "$AR/keep/2026-11-01/a.jpg" -a -f "$AR/shots/2026-11-02/b.jpg"
  end_env
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAILN"
[ "$FAILN" -eq 0 ]
