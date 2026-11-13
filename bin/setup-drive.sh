#!/bin/sh
# setup-drive.sh - one-time Google Drive login for rclone, with the trade-off
# explained BEFORE anything happens. Never prints or logs the token or config.
MW_BIN=$(cd "$(dirname "$0")" && pwd)
. "$MW_BIN/lib.sh"
MW_NAME=setup
mw_load_config

command -v rclone >/dev/null 2>&1 || { echo "Install rclone first:  brew install rclone"; exit 1; }

cat <<EOF2
Google Drive setup for mac-watch
================================
This creates an rclone remote called '$RCLONE_REMOTE' with scope 'drive' (FULL access
to your Google Drive).

Why full access: you create the phone markers (snap-now, record-5min) yourself in
the Drive app. The narrower 'drive.file' scope only sees files rclone created, so it
would never see them.

The trade-off: whoever gets a copy of ~/.config/rclone/rclone.conf can read and
write your whole Drive. What limits that:
  - this script sets the file to chmod 600 (only you can read it)
  - keep FileVault on
  - you can revoke the token any time at https://myaccount.google.com/permissions

What will happen next: your browser opens, you pick your Google account, click
"Allow" on the Google consent screen (it may warn the app is unverified: click
Advanced, then continue), then come back to this window. Nothing else is asked.

EOF2
if rclone listremotes 2>/dev/null | grep -qx "$RCLONE_REMOTE:"; then
  echo "A remote named '$RCLONE_REMOTE' already exists; I will not overwrite it."
  echo "To log in again: rclone config reconnect $RCLONE_REMOTE:"
else
  printf 'Type "yes" to continue: '
  read -r ans
  [ "$ans" = yes ] || { echo "Cancelled. Nothing was changed."; exit 1; }
  # scope=drive, client_id blank (rclone's shared id; see README if rate-limited)
  rclone config create "$RCLONE_REMOTE" drive scope=drive >/dev/null || { echo "rclone login failed."; exit 1; }
fi

cfg=$(rclone config file 2>/dev/null | tail -n 1)
if [ -f "$cfg" ]; then
  chmod 600 "$cfg" && echo "set permissions 600 on the rclone config"
fi

echo "testing the connection (lists nothing, just checks login)..."
if rclone lsd "$RCLONE_REMOTE:" --max-depth 0 >/dev/null 2>&1; then
  echo "login works."
  rclone mkdir "$RCLONE_REMOTE:$DRIVE_FOLDER/control" && echo "created Drive folder $DRIVE_FOLDER/control"
  echo "Done. Next: ./bin/selftest.sh"
else
  echo "Could not talk to Drive. Try: rclone config reconnect $RCLONE_REMOTE:"
  exit 1
fi
