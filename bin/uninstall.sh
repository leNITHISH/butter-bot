#!/bin/sh
# uninstall.sh [--purge]
# Stops and removes the three LaunchAgents. Keeps your data and config.
#   --purge  also deletes queue/, tmp/, log/, state/ (asks first). Never touches
#            config.env, the rclone config, or anything in Google Drive.
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
mw_load_config

AGENTS_DIR=${MW_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
uid=$(id -u)

for a in capture upload record; do
  label=com.macwatch.$a
  launchctl bootout "gui/$uid/$label" >/dev/null 2>&1
  if [ -f "$AGENTS_DIR/$label.plist" ]; then
    rm -f "$AGENTS_DIR/$label.plist"
    echo "removed $AGENTS_DIR/$label.plist"
  fi
done
rm -rf "$MW_STATE/record.lock" "$MW_STATE/upload.lock"
echo "mac-watch agents stopped and removed. It will not start at login any more."

if [ "${1:-}" = "--purge" ]; then
  printf 'Delete queued screenshots, logs and state in %s ? [y/N] ' "$MW_HOME"
  read -r ans
  case $ans in
    y|Y|yes|YES)
      rm -rf "$MW_QUEUE" "$MW_TMP" "$MW_LOG" "$MW_STATE"
      echo "deleted queue/ tmp/ log/ state/" ;;
    *) echo "kept your data" ;;
  esac
else
  echo "Your data is untouched: $MW_HOME/{queue,log,state} and config.env."
  echo "Add --purge to delete the local data too. Drive files are never touched; delete them in Drive yourself."
fi
[ -d "$MW_HOME/MacWatch.app" ] && echo "Note: $MW_HOME/MacWatch.app (optional wrapper) is still there; delete it if you like."
exit 0
