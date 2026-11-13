#!/bin/sh
# trigger.sh <reason> - the single entry point for every capture.
# gate (lid open, no PAUSE) -> per-reason debounce -> capture.sh.
# Reasons: interval, login, remote, space, wake, lock, unlock, selftest, manual ...
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
mw_init capture

reason=${1:-manual}
case $reason in
  ''|*[!a-z0-9-]*) log ERROR "trigger: bad reason '$reason' (use a-z 0-9 -)"; exit 2 ;;
esac

gate || exit 0

# Debounce: one capture per min_gap_for(reason) seconds. The stamp is written
# before capturing so a slow or failing capture cannot be hammered either.
gap=$(min_gap_for "$reason")
if [ "$gap" -gt 0 ]; then
  if ! lock_acquire "debounce-$reason" 1; then
    debug "trigger $reason: another trigger is deciding, skipping"
    exit 0
  fi
  stamp=$MW_STATE/last-trigger-$reason
  last=$(cat "$stamp" 2>/dev/null)
  case $last in ''|*[!0-9]*) last=0 ;; esac
  t=$(now)
  if [ $((t - last)) -lt "$gap" ]; then
    lock_release "debounce-$reason"
    debug "trigger $reason: debounced (gap ${gap}s)"
    exit 0
  fi
  echo "$t" > "$stamp"
  lock_release "debounce-$reason"
fi

"$MW_BIN/capture.sh" "$reason"
rc=$?

# The periodic shot doubles as the heartbeat (battery, power, Wi-Fi, uptime).
[ "$reason" = interval ] && "$MW_BIN/heartbeat.sh" beat
exit $rc
