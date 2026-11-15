#!/bin/sh
# setup-remote.sh [--rclone-only] [--new-token]
# One-time setup on the Mac (safe to run again):
#   1. the rclone remote for Backblaze B2 ("b2"), from the Mac's B2 key (hidden input)
#   2. the Mac token for the Worker (.mac-token, chmod 600). Prints only its SHA-256 hash,
#      which you store on the laptop with: ./worker/put-secrets.sh MAC_TOKEN_HASH
#   3. a check that both work
#   --rclone-only  just step 1 (e.g. on an archive laptop for ./bin/archive-pull.sh)
#   --new-token    replace an existing Mac token (the old one stops working once you store the new hash)
# Never prints, logs or commits the key, the token or the rclone config.
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
# shellcheck source=api.sh
. "$MW_BIN/api.sh"
mw_load_config
mkdir -p "$MW_TMP" "$MW_STATE" "$MW_LOG" 2>/dev/null

rclone_only=0; new_token=0
for a in "$@"; do
  case $a in
    --rclone-only) rclone_only=1 ;;
    --new-token) new_token=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
umask 077

say() { printf '%s\n' "$*"; }
ask() { printf '%s' "$1"; read -r ans; }
ask_hidden() { printf '%s' "$1"; stty -echo 2>/dev/null; read -r ans; stty echo 2>/dev/null; echo; }

command -v rclone >/dev/null 2>&1 || { say "Install rclone first:  brew install rclone"; exit 1; }

say "mac-watch remote setup"
say "  bucket:  $B2_BUCKET"
say "  Worker:  $WORKER_URL"
say "  (both come from config.env)"
say ""

# ---------------------------------------------------------------- 1. rclone --
cfg=$(rclone config file 2>/dev/null | tail -n 1)
if rclone listremotes 2>/dev/null | grep -qx "$RCLONE_REMOTE:"; then
  say "1. rclone remote '$RCLONE_REMOTE' already exists; keeping it."
  say "   (To replace the key: rclone config delete $RCLONE_REMOTE, then run this again.)"
else
  say "1. The Mac's Backblaze key (Application Keys > the one named macwatch-mac)."
  ask "   keyID: "
  key_id=$ans
  case $key_id in ''|*[!A-Za-z0-9]*) say "   that does not look like a keyID (letters and digits only). Nothing changed."; exit 1 ;; esac
  ask_hidden "   applicationKey (hidden): "
  app_key=$ans
  [ -n "$app_key" ] || { say "   no applicationKey given. Nothing changed."; exit 1; }
  # rclone stores the key obscured. `rclone obscure -` reads it from stdin, so it never
  # appears in a process list. The section is appended directly for the same reason.
  obsc=$(printf '%s' "$app_key" | rclone obscure - 2>/dev/null)
  app_key=
  [ -n "$obsc" ] || { say "   rclone obscure failed. Nothing changed."; exit 1; }
  [ -n "$cfg" ] || { say "   cannot find the rclone config file location. Nothing changed."; exit 1; }
  mkdir -p "$(dirname "$cfg")"
  touch "$cfg" && chmod 600 "$cfg"
  {
    printf '\n[%s]\n' "$RCLONE_REMOTE"
    printf 'type = b2\n'
    printf 'account = %s\n' "$key_id"
    printf 'key = %s\n' "$obsc"
    printf 'hard_delete = true\n'
  } >> "$cfg"
  obsc=
  say "   rclone remote '$RCLONE_REMOTE' created (config is chmod 600)."
fi
[ -f "$cfg" ] && chmod 600 "$cfg"

printf '   checking the bucket... '
if rclone lsf "$RCLONE_REMOTE:$B2_BUCKET" --max-depth 1 >/dev/null 2>"$MW_TMP/setup.err"; then
  say "OK"
else
  say "FAILED"
  say "   $(tail -n 2 "$MW_TMP/setup.err" | redact | tr '\n' ' ')"
  say "   Check the keyID/applicationKey (rclone config delete $RCLONE_REMOTE, then run this again)"
  say "   and that the key is allowed to use bucket $B2_BUCKET."
  rm -f "$MW_TMP/setup.err"
  exit 1
fi
rm -f "$MW_TMP/setup.err"
[ "$rclone_only" = 1 ] && { say "Done (--rclone-only)."; exit 0; }

# ---------------------------------------------------------------- 2. token ---
say ""
if [ -s "$MW_TOKEN_FILE" ] && [ "$new_token" = 0 ]; then
  say "2. Mac token exists ($MW_TOKEN_FILE); keeping it. (--new-token makes a new one.)"
else
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$MW_TOKEN_FILE.new" && chmod 600 "$MW_TOKEN_FILE.new" &&
    mv "$MW_TOKEN_FILE.new" "$MW_TOKEN_FILE" || { say "could not write $MW_TOKEN_FILE"; exit 1; }
  say "2. Created a new Mac token in $MW_TOKEN_FILE (chmod 600, never leaves this Mac)."
fi
chmod 600 "$MW_TOKEN_FILE"
hash=$(tr -d ' \r\n' < "$MW_TOKEN_FILE" | sha256_hex)

# ---------------------------------------------------------------- 3. check ---
say ""
printf '3. checking the Worker... '
api GET "/mac/poll?paused=no" "$MW_TMP/setup.out"
code=$API_CODE
rm -f "$MW_TMP/setup.out"
case $code in
  200) say "OK: the Worker accepts this Mac."
       say ""
       say "All set. Next: ./bin/install.sh (or run it again), then ./bin/selftest.sh" ;;
  401) say "not accepted yet (that is expected the first time)."
       say ""
       say "   On the laptop, in the butter-bot folder, run:"
       say "       ./worker/put-secrets.sh MAC_TOKEN_HASH"
       say "   and paste this hash (it is NOT the token; safe to copy between computers):"
       say ""
       say "       $hash"
       say ""
       say "   Then run ./bin/setup-remote.sh again here to check (it keeps the token)." ;;
  *)   say "no answer (HTTP $code): $(api_problem "$code")"
       say "   Your token hash, for ./worker/put-secrets.sh MAC_TOKEN_HASH on the laptop:"
       say "       $hash" ;;
esac
exit 0
