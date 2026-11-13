#!/bin/sh
# setup-oauth.sh - switch the rclone remote to YOUR OWN Google OAuth client.
# Fixes "rateLimitExceeded": rclone's built-in client ID is shared by everyone.
# You do the Google Cloud part in a browser (free); this script then stores the
# client ID/secret in rclone's config and re-runs the login. It never prints or
# logs the secret. (While rclone runs, the secret is briefly visible to other
# processes of your own user in `ps`; on a single-user laptop that is acceptable.)
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
mw_load_config

command -v rclone >/dev/null 2>&1 || { echo "Install rclone first: brew install rclone"; exit 1; }

cat <<EOF2
Own Google OAuth client for mac-watch
=====================================
Do these in your browser (Google may change wording; the goal is a "Desktop app" OAuth client):

 1. Open https://console.cloud.google.com/ and create a project (name: mac-watch).
 2. APIs & Services > Library > search "Google Drive API" > Enable.
 3. APIs & Services > OAuth consent screen (may be called "Google Auth Platform"):
      - User type: External. Fill in app name (mac-watch) and your email. Save.
      - IMPORTANT: set Publishing status to "In production" (button "Publish app").
        In "Testing" status Google expires the login after ~7 days and mac-watch
        silently stops uploading. Production is fine for an app only you use; the
        "unverified app" warning at login is expected: Advanced > continue.
 4. APIs & Services > Credentials > Create credentials > OAuth client ID >
    Application type: Desktop app > Create.
 5. Copy the Client ID and the Client secret shown.

Scope stays 'drive' (full access), same trade-off as before; revoke any time at
https://myaccount.google.com/permissions.

EOF2
printf 'Paste the Client ID (or press Enter to cancel): '
read -r cid
[ -n "$cid" ] || { echo "Cancelled. Nothing was changed."; exit 1; }
printf 'Paste the Client secret (typing is hidden): '
stty -echo 2>/dev/null
read -r csec
stty echo 2>/dev/null
echo
[ -n "$csec" ] || { echo "No secret entered. Nothing was changed."; exit 1; }

if ! rclone listremotes 2>/dev/null | grep -qx "$RCLONE_REMOTE:"; then
  echo "No remote '$RCLONE_REMOTE' yet. Run ./bin/setup-drive.sh first."
  exit 1
fi

rclone config update "$RCLONE_REMOTE" client_id="$cid" client_secret="$csec" scope=drive >/dev/null || { echo "Could not update the rclone config."; exit 1; }
cid=; csec=
echo "Saved. Now logging in again with your own client: your browser opens; click Allow."
rclone config reconnect "$RCLONE_REMOTE:" || { echo "Login failed. Re-run this script."; exit 1; }
cfg=$(rclone config file 2>/dev/null | tail -n 1)
[ -f "$cfg" ] && chmod 600 "$cfg"

rm -f "$MW_STATE/backoff-until" "$MW_STATE/error-upload"
if rclone lsd "$RCLONE_REMOTE:" --max-depth 0 >/dev/null 2>&1; then
  echo "Drive login works with your own client. Run ./bin/selftest.sh to confirm."
else
  echo "Still cannot reach Drive; try again in a minute, then run ./bin/diagnose.sh."
  exit 1
fi
