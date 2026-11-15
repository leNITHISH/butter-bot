#!/bin/sh
# api.sh - talk to the Worker (WORKER_URL). Source it after lib.sh; do not run it.
#
#   api METHOD PATH OUTFILE [BODYFILE]
#       Writes the response body to OUTFILE and the HTTP status to $API_CODE (000 = no
#       connection). Returns 0 for 2xx, 1 for any other answer, 2 when not configured.
#
# The Mac token lives in $MW_HOME/.mac-token (chmod 600, git-ignored, made by
# setup-remote.sh). It is handed to curl on stdin (-K -), so it never shows up in
# `ps`, in logs, or in the test stubs' call records. Nothing here echoes it.

MW_TOKEN_FILE=${MW_TOKEN_FILE:-$MW_HOME/.mac-token}
API_TIMEOUT=${API_TIMEOUT:-15}

api_configured() {
  [ -n "${WORKER_URL:-}" ] && [ -s "$MW_TOKEN_FILE" ]
}

api() { # METHOD PATH OUTFILE [BODYFILE]
  API_CODE=000
  : > "$3"
  api_configured || return 2
  _tok=$(tr -d ' \r\n' < "$MW_TOKEN_FILE")
  if [ -n "${4:-}" ]; then
    API_CODE=$(printf 'header = "Authorization: Bearer %s"\n' "$_tok" |
      curl -s -K - -X "$1" --max-time "$API_TIMEOUT" --retry 1 --retry-delay 1 \
        -H 'Content-Type: text/plain' --data-binary "@$4" \
        -o "$3" -w '%{http_code}' "$WORKER_URL$2" 2>/dev/null)
  else
    API_CODE=$(printf 'header = "Authorization: Bearer %s"\n' "$_tok" |
      curl -s -K - -X "$1" --max-time "$API_TIMEOUT" --retry 1 --retry-delay 1 \
        -o "$3" -w '%{http_code}' "$WORKER_URL$2" 2>/dev/null)
  fi
  _tok=
  case $API_CODE in
    2??) return 0 ;;
    ''|*[!0-9]*) API_CODE=000 ;;
  esac
  return 1
}

# A one-line explanation for a failed call, for logs and status.sh.
api_problem() { # CODE
  case $1 in
    000) echo "cannot reach the Worker ($WORKER_URL): offline?" ;;
    401) echo "the Worker refused this Mac's token. Fix: run ./bin/setup-remote.sh on the Mac, then on the laptop: ./worker/put-secrets.sh MAC_TOKEN_HASH" ;;
    5??) echo "the Worker had a problem (HTTP $1); it retries by itself" ;;
    *)   echo "unexpected answer from the Worker (HTTP $1)" ;;
  esac
}
