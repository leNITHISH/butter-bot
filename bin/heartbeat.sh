#!/bin/sh
# heartbeat.sh beat|power
#   beat   one status line in log/events.log (battery, power, Wi-Fi, uptime, queue)
#   power  log a line whenever the power source changes (e.g. charger unplugged)
MW_BIN=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$MW_BIN/lib.sh"
mw_init events

power_source() {
  case $(pmset -g batt 2>/dev/null | head -n 1) in
    *"AC Power"*)      echo AC ;;
    *"Battery Power"*) echo Battery ;;
    *"UPS Power"*)     echo UPS ;;
    *)                 echo unknown ;;
  esac
}
battery_pct() { pmset -g batt 2>/dev/null | grep -o '[0-9]*%' | head -n 1; }

case ${1:-beat} in
  power)
    cur=$(power_source)
    [ "$cur" = unknown ] && exit 0
    prev=$(cat "$MW_STATE/last-power" 2>/dev/null)
    if [ -n "$prev" ] && [ "$prev" != "$cur" ]; then
      if [ "$cur" = Battery ]; then
        log WARN "POWER: $prev -> $cur (charger unplugged) battery=$(battery_pct)"
      else
        log INFO "POWER: $prev -> $cur battery=$(battery_pct)"
      fi
    fi
    echo "$cur" > "$MW_STATE/last-power"
    ;;
  beat)
    dev=$(networksetup -listallhardwareports 2>/dev/null | awk '/Wi-Fi|AirPort/ {getline; print $2; exit}')
    wifi=unknown
    if [ -n "$dev" ]; then
      case $(networksetup -getairportpower "$dev" 2>/dev/null) in
        *": On"*)  wifi=on ;;
        *": Off"*) wifi=off ;;
      esac
    fi
    up=$(uptime | sed -e 's/^.*up *//' -e 's/, *[0-9][0-9]* user.*$//' -e 's/  */ /g')
    online=$(cat "$MW_STATE/online" 2>/dev/null)
    log INFO "HEARTBEAT battery=$(battery_pct) power=$(power_source) wifi=$wifi online=${online:-?} uptime=\"$up\" queue=$(queue_count)"
    ;;
  *) echo "usage: heartbeat.sh beat|power" >&2; exit 2 ;;
esac
exit 0
