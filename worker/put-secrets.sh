#!/bin/sh
# put-secrets.sh - store the Worker's secrets in Cloudflare (run on the laptop, from anywhere).
# Asks for each value; press Enter to skip one and keep what Cloudflare already has.
# Hidden input for the key; nothing is printed, logged or written to disk.
# Needs: node/npx, a logged-in wrangler (npx wrangler login), curl.
#
#   ./worker/put-secrets.sh            everything (first time)
#   ./worker/put-secrets.sh MAC_TOKEN_HASH    just one
cd "$(dirname "$0")" || exit 1

BUCKET_DEFAULT=macwatch-twjdnu

put() { # NAME VALUE
  if printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null 2>&1; then
    echo "  saved $1"
  else
    echo "  FAILED to save $1 (is wrangler logged in? try: npx wrangler login)"; exit 1
  fi
}
ask() { # PROMPT -> $ans (visible)
  printf '%s' "$1"; read -r ans
}
ask_hidden() { # PROMPT -> $ans (not echoed)
  printf '%s' "$1"
  stty -echo 2>/dev/null; read -r ans; stty echo 2>/dev/null; echo
}
want() { [ -z "$only" ] || [ "$only" = "$1" ]; }
only=${1:-}

echo "mac-watch: Worker secrets (Enter = skip and keep the current value)"
echo

if want B2_BUCKET; then
  ask "B2 bucket name [$BUCKET_DEFAULT]: "
  put B2_BUCKET "${ans:-$BUCKET_DEFAULT}"
  bucket=${ans:-$BUCKET_DEFAULT}
fi

if want B2_KEY_ID || want B2_APP_KEY; then
  echo
  echo "The WORKER key from Backblaze (Application Keys, the one named macwatch-worker)."
  ask "  keyID: "
  key_id=$ans
  if [ -n "$key_id" ]; then
    case $key_id in *[!A-Za-z0-9]*) echo "  that does not look like a keyID (letters and digits only)"; exit 1 ;; esac
    ask_hidden "  applicationKey (hidden): "
    app_key=$ans
    [ -n "$app_key" ] || { echo "  no applicationKey given; nothing saved"; exit 1; }
    # check it before saving: authorize once and see which bucket it is limited to
    out=$(printf 'user = "%s:%s"\n' "$key_id" "$app_key" | curl -s -m 20 -K - https://api.backblazeb2.com/b2api/v3/b2_authorize_account)
    case $out in
      *'"authorizationToken"'*)
        if printf '%s' "$out" | grep -q "\"name\": *\"${bucket:-$BUCKET_DEFAULT}\""; then
          echo "  key works and is limited to bucket ${bucket:-$BUCKET_DEFAULT}"
        else
          echo "  key works but is NOT limited to bucket ${bucket:-$BUCKET_DEFAULT}. Better: make one restricted to that bucket."
        fi ;;
      *) echo "  Backblaze refused this key (typo? copied the keyID and applicationKey of the same key?). Nothing saved."; exit 1 ;;
    esac
    out=
    put B2_KEY_ID "$key_id"
    put B2_APP_KEY "$app_key"
    app_key=
  fi
fi

if want ALLOWED_EMAIL; then
  echo
  ask "Your Google e-mail (the ONLY account allowed to sign in): "
  [ -n "$ans" ] && put ALLOWED_EMAIL "$ans"
fi

if want GOOGLE_CLIENT_ID; then
  echo
  echo "Google sign-in Client ID (ends in .apps.googleusercontent.com; public, not a secret)."
  ask "  Client ID: "
  if [ -n "$ans" ]; then
    case $ans in *.apps.googleusercontent.com) put GOOGLE_CLIENT_ID "$ans" ;; *) echo "  that is not a Google client ID; skipped" ;; esac
  fi
fi

if want MAC_TOKEN_HASH; then
  echo
  echo "Mac token hash: printed by ./bin/setup-remote.sh on the Mac (64 hex characters)."
  ask "  hash: "
  if [ -n "$ans" ]; then
    h=$(printf '%s' "$ans" | tr 'A-F' 'a-f' | tr -d ' ')
    case $h in
      *[!0-9a-f]*) echo "  not hex; skipped" ;;
      *) if [ "${#h}" -eq 64 ]; then put MAC_TOKEN_HASH "$h"; else echo "  not 64 characters; skipped"; fi ;;
    esac
  fi
fi

if want SESSION_SECRET; then
  echo
  ask "Create a new session secret (signs everyone out)? [y/N, say y the first time]: "
  case $ans in
    y|Y|yes)
      s=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
      put SESSION_SECRET "$s"; s= ;;
  esac
fi

echo
echo "Done. Secrets apply immediately (no redeploy needed)."
