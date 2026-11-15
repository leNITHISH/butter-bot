#!/bin/sh
# install.sh [--wrapper] [--hammerspoon] [--no-hammerspoon]
# Idempotent: safe to run again (do so after editing INTERVAL_SEC or CONTROL_POLL_SEC).
#   (default)       four LaunchAgents run /bin/sh directly (capture, upload, listen, record)
#   --wrapper       run them through ~/mac-watch/MacWatch.app instead. Fallback for when
#                   Screen Recording permission will not stick to /bin/sh (see README).
#   --hammerspoon   after asking, add ONE line to ~/.hammerspoon/init.lua (Phase 3 triggers),
#                   and start Hammerspoon at every login (a fourth LaunchAgent). While
#                   enabled, mac-watch also restarts Hammerspoon if it is not running.
#   --no-hammerspoon  undo that: remove the login agent and stop restarting it
# Writes only inside this folder and ~/Library/LaunchAgents. No sudo. No power settings.
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
mw_load_config

use_wrapper=0
want_hs=0
no_hs=0
for arg in "$@"; do
  case $arg in
    --wrapper) use_wrapper=1 ;;
    --hammerspoon) want_hs=1 ;;
    --no-hammerspoon) no_hs=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != Darwin ]; then
  echo "install.sh only works on macOS (this is $(uname -s))." >&2
  exit 1
fi

AGENTS_DIR=${MW_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
uid=$(id -u)
APP=$MW_HOME/MacWatch.app
say() { printf '%s\n' "$*"; }

say "mac-watch install"
say "  folder:         $MW_HOME"
[ "$MW_HOME" = "$HOME/mac-watch" ] || say "  note: the plan was to keep this in ~/mac-watch. It works from anywhere, but then every path below is under $MW_HOME."

# --- prerequisites ----------------------------------------------------------
missing=
for c in screencapture sips ioreg curl launchctl; do
  command -v "$c" >/dev/null 2>&1 || missing="$missing $c"
done
if [ -n "$missing" ]; then
  say "ERROR: missing macOS tools:$missing" >&2
  exit 1
fi
if ! command -v rclone >/dev/null 2>&1; then
  say ""
  say "!! rclone is not installed. Captures will queue locally but nothing can upload."
  say "   Install it:   brew install rclone"
  say "   Then:         ./bin/setup-remote.sh"
elif ! rclone listremotes 2>/dev/null | grep -qx "$RCLONE_REMOTE:"; then
  say ""
  say "!! rclone has no remote called '$RCLONE_REMOTE'. Captures will queue but not upload."
  say "   Run:  ./bin/setup-remote.sh    (asks for the Mac's Backblaze key)"
fi
if [ ! -s "$MW_HOME/.mac-token" ]; then
  say ""
  say "!! No Mac token yet, so the web page cannot reach this Mac. Run: ./bin/setup-remote.sh"
fi

# --- folders ----------------------------------------------------------------
umask 077
mkdir -p "$MW_QUEUE" "$MW_TMP" "$MW_LOG" "$MW_STATE" "$AGENTS_DIR" || exit 1

# --- optional app wrapper ---------------------------------------------------
if [ "$use_wrapper" = 1 ]; then
  "$MW_BIN/make-wrapper.sh" "$APP" || exit 1
fi

# --- plists -----------------------------------------------------------------
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
s() { printf '    <string>%s</string>\n' "$(printf '%s' "$1" | xml)"; }

# program_args SCRIPT ARG...   -> the ProgramArguments array body
program_args() {
  if [ "${plain_args:-0}" = 1 ]; then
    for _a in "$@"; do s "$_a"; done
  elif [ "$use_wrapper" = 1 ]; then
    s /usr/bin/open; s -n; s -W; s -g; s -a; s "$APP"; s --args
    for _a in "$@"; do s "$_a"; done
  else
    s /bin/sh
    for _a in "$@"; do s "$_a"; done
  fi
}

# write_plist NAME EXTRA_XML SCRIPT ARG...
write_plist() {
  _name=$1; _extra=$2; shift 2
  _label=com.macwatch.$_name
  _file=$AGENTS_DIR/$_label.plist
  {
    cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$_label</string>
  <key>ProgramArguments</key>
  <array>
PLIST
    program_args "$@"
    cat <<PLIST
  </array>
$_extra  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$(printf '%s' "$MW_LOG/launchd-$_name.log" | xml)</string>
  <key>StandardErrorPath</key>
  <string>$(printf '%s' "$MW_LOG/launchd-$_name.log" | xml)</string>
</dict>
</plist>
PLIST
  } > "$_file.new" && mv "$_file.new" "$_file"
  command -v plutil >/dev/null 2>&1 && { plutil -lint "$_file" >/dev/null || { say "ERROR: bad plist $_file" >&2; exit 1; }; }
  echo "$_file"
}

# The capture agent wakes up every CONTROL_POLL_SEC; trigger.sh only takes a shot once
# INTERVAL_SEC has passed. That is what lets INTERVAL_SEC be changed live (from the web page).
capture_extra="  <key>StartInterval</key>
  <integer>$CONTROL_POLL_SEC</integer>
  <key>RunAtLoad</key>
  <true/>
"
upload_extra="  <key>StartInterval</key>
  <integer>$CONTROL_POLL_SEC</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>WatchPaths</key>
  <array>
    <string>/Library/Preferences/SystemConfiguration/</string>
  </array>
  <key>AbandonProcessGroup</key>
  <true/>
"
record_extra="  <key>RunAtLoad</key>
  <false/>
"
# The web page's control channel: a long-running poll loop. launchd restarts it if it
# exits (at most every 30 s), and it starts at login.
listen_extra="  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
"

say ""
say "writing LaunchAgents to $AGENTS_DIR"
cap_plist=$(write_plist capture "$capture_extra" "$MW_BIN/trigger.sh" interval)
upl_plist=$(write_plist upload  "$upload_extra"  "$MW_BIN/upload.sh")
rec_plist=$(write_plist record  "$record_extra"  "$MW_BIN/record.sh" --request)
lst_plist=$(write_plist listen  "$listen_extra"  "$MW_BIN/listen.sh")

# --- Hammerspoon login agent (only when opted in) ----------------------------
hs_plist=
if [ "$no_hs" = 1 ]; then
  launchctl bootout "gui/$uid/com.macwatch.hammerspoon" >/dev/null 2>&1
  rm -f "$AGENTS_DIR/com.macwatch.hammerspoon.plist" "$MW_STATE/hammerspoon-enabled"
  say "  Hammerspoon login agent removed"
elif [ "$want_hs" = 1 ] || [ -e "$MW_STATE/hammerspoon-enabled" ]; then
  : > "$MW_STATE/hammerspoon-enabled"
  plain_args=1
  hs_plist=$(write_plist hammerspoon "  <key>RunAtLoad</key>
  <true/>
" /usr/bin/open -g -a Hammerspoon)
  plain_args=0
fi

# --- load them (bootout first so re-running picks up changes) ---------------
for p in "$cap_plist" "$upl_plist" "$rec_plist" "$lst_plist" $hs_plist; do
  label=$(basename "$p" .plist)
  launchctl bootout "gui/$uid/$label" >/dev/null 2>&1
  if launchctl bootstrap "gui/$uid" "$p"; then
    launchctl enable "gui/$uid/$label" >/dev/null 2>&1
    say "  loaded $label"
  else
    say "  FAILED to load $label (see: launchctl print gui/$uid/$label)" >&2
  fi
done

# --- Hammerspoon (asks first; it is outside our folders) --------------------
if [ "$want_hs" = 1 ]; then
  hs_init=$HOME/.hammerspoon/init.lua
  hs_line="dofile(\"$MW_HOME/hammerspoon/init.lua\") -- mac-watch"
  say ""
  if [ -f "$hs_init" ] && grep -q 'mac-watch' "$hs_init"; then
    say "Hammerspoon already loads mac-watch ($hs_init)."
  else
    say "This will add ONE line to $hs_init (outside ~/mac-watch):"
    say "    $hs_line"
    printf 'Add it? [y/N] '
    read -r ans
    case $ans in
      y|Y|yes|YES)
        mkdir -p "$HOME/.hammerspoon"
        printf '\n%s\n' "$hs_line" >> "$hs_init"
        say "added. In Hammerspoon choose 'Reload Config'." ;;
      *) say "skipped. Add the line yourself when you want the spacebar and wake triggers." ;;
    esac
  fi
fi

# --- what happens next ------------------------------------------------------
cat <<EOF2

Installed. What to know:

 1. macOS may now show "Background Items Added" for mac-watch. That is these
    agents. If it asks, allow them: System Settings > General > Login Items &
    Extensions. If they are switched off there, nothing runs.

 2. SCREEN RECORDING PERMISSION (the one that matters). Without it, screenshots
    silently show only your wallpaper and menu bar. Grant it to /bin/sh:
      System Settings > Privacy & Security > Screen & System Audio Recording
      > "+" > press Cmd+Shift+G > type /bin/sh > Open > switch it on.
    If shots are still wallpaper-only, re-run with:  ./bin/install.sh --wrapper
    and grant "MacWatch" instead. Then run:  ./bin/selftest.sh

 3. It starts when you LOG IN, not when the Mac boots. After a power cut or
    reboot nothing runs until you log in (FileVault turns auto-login off).

 4. Remote control: open $WORKER_URL on your phone
    (sign in with Google): status, Screenshot now, Live, Record, Pause, files, storage.

 5. Stop everything instantly:   touch $MW_PAUSE
    Resume:                       rm $MW_PAUSE
    Status:                       ./bin/status.sh
    Remove completely:            ./bin/uninstall.sh
EOF2
exit 0
