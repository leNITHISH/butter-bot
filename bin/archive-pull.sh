#!/bin/sh
# archive-pull.sh - copy shots/recordings from Google Drive to THIS computer (run it on your
# archive laptop; it only needs rclone and this repo, not the Mac's capture setup).
#
#   ./bin/archive-pull.sh                      copy the keep/ folder (things you marked "Keep")
#   ./bin/archive-pull.sh --all                also copy shots/ and recordings/
#   ./bin/archive-pull.sh --all --days 3       ...only files from the last 3 days
#   ./bin/archive-pull.sh --dest ~/Pictures/mac-watch
#   ./bin/archive-pull.sh --dry-run            show what would happen, change nothing
#   ./bin/archive-pull.sh --free-drive         after a VERIFIED copy, delete the copied files from
#                                              Drive (asks you to type "delete"; permanent)
#
# Without --free-drive nothing is ever deleted. Drive prunes shots/ and recordings/ after
# RETENTION_DAYS (14), so pull them within that time; keep/ is never pruned.
# One-time login on this computer: ./bin/setup-oauth.sh (same Google client as the Mac).
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
mw_load_config

dest=$HOME/mac-watch-archive
all=0; days=; free=0; dry=
while [ $# -gt 0 ]; do
  case $1 in
    --dest)       dest=${2:?--dest needs a folder}; shift ;;
    --all)        all=1 ;;
    --days)       days=${2:?--days needs a number}; shift
                  case $days in ''|*[!0-9]*) echo "--days needs a number" >&2; exit 2 ;; esac ;;
    --free-drive) free=1 ;;
    --dry-run)    dry=--dry-run ;;
    -h|--help)    sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v rclone >/dev/null 2>&1 || { echo "rclone is not installed (brew install rclone / pacman -S rclone)"; exit 1; }
rclone listremotes 2>/dev/null | grep -qx "$RCLONE_REMOTE:" || {
  echo "No rclone remote '$RCLONE_REMOTE' on this computer. Run ./bin/setup-oauth.sh first."; exit 1; }

mkdir -p "$dest" || exit 1
kinds=keep
[ "$all" = 1 ] && kinds="keep shots recordings"
age=
[ -n "$days" ] && age="--max-age ${days}d"

failed=0
for k in $kinds; do
  src=$(rpath "$k")
  # shellcheck disable=SC2086  # $age and $dry are intentionally word-split flags
  rclone copy "$src" "$dest/$k" $age $dry -q 2>/dev/null
  rc=$?
  case $rc in
    0) ;;
    3) echo "[$k] nothing in Drive yet"; continue ;;
    *) echo "[$k] copy FAILED (exit $rc)"; failed=1; continue ;;
  esac
  if [ -z "$dry" ]; then
    # shellcheck disable=SC2086
    if rclone check "$src" "$dest/$k" --one-way $age -q 2>/dev/null; then
      echo "[$k] verified: everything in Drive is on this computer ($(find "$dest/$k" -type f 2>/dev/null | wc -l | tr -d ' ') file(s) in $dest/$k)"
    else
      echo "[$k] VERIFY FAILED: some files differ or are missing here. Nothing was deleted."
      failed=1
    fi
  fi
done
[ "$failed" = 0 ] || { echo "Stopped: fix the problem above and run again."; exit 1; }

if [ "$free" = 1 ] && [ -z "$dry" ]; then
  echo
  echo "--free-drive: every file just verified will be DELETED from Drive (permanently, no Trash)."
  printf 'Type "delete" to continue: '
  read -r ans
  [ "$ans" = delete ] || { echo "Not deleting anything."; exit 0; }
  for k in $kinds; do
    # shellcheck disable=SC2086
    rclone delete "$(rpath "$k")" $age --drive-use-trash=false -q 2>/dev/null
    rclone rmdirs "$(rpath "$k")" --leave-root -q 2>/dev/null
    echo "[$k] removed from Drive"
  done
fi
echo "Archive folder: $dest"
exit 0
