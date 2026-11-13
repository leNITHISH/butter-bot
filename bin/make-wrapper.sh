#!/bin/sh
# make-wrapper.sh APP_PATH - build a tiny AppleScript app that runs "sh <args>".
# Fallback for Screen Recording permission: macOS attaches the permission to the
# launching app, and a named app is easier to find and approve than /bin/sh.
# Uses only osacompile, defaults and codesign, which ship with macOS.
APP=${1:?usage: make-wrapper.sh /path/MacWatch.app}
command -v osacompile >/dev/null 2>&1 || { echo "osacompile not found (macOS only)" >&2; exit 1; }
rm -rf "$APP"
osacompile -o "$APP" \
  -e 'on run argv' \
  -e 'set cmd to "/bin/sh"' \
  -e 'repeat with a in argv' \
  -e 'set cmd to cmd & " " & quoted form of (a as text)' \
  -e 'end repeat' \
  -e 'do shell script cmd' \
  -e 'end run' || exit 1
# no Dock icon, stable identity for the permission list
defaults write "$APP/Contents/Info" LSUIElement -bool true
defaults write "$APP/Contents/Info" CFBundleIdentifier com.macwatch.runner
defaults write "$APP/Contents/Info" CFBundleName MacWatch
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "note: ad-hoc codesign failed; the app still works but may need re-approval after edits" >&2
echo "built $APP"
