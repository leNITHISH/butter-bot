-- mac-watch: Phase 3 event triggers for Hammerspoon.
--
-- Load it from ~/.hammerspoon/init.lua with ONE line (./bin/install.sh --hammerspoon
-- offers to add it after asking you):
--     dofile("/Users/you/mac-watch/hammerspoon/init.lua")
--
-- What it does:
--   * spacebar pressed        -> bin/trigger.sh space, taken SPACE_SETTLE_SEC after the
--                                last space of a typing burst, so the shot shows what you
--                                just typed (trigger.sh still applies SPACE_MIN_GAP_SEC)
--   * wake from sleep         -> bin/trigger.sh wake
--   * screen locked/unlocked  -> bin/trigger.sh lock / unlock
-- Every trigger goes through bin/trigger.sh, which checks the lid and the PAUSE file.
--
-- PRIVACY: THIS IS NOT A KEYLOGGER.
--   The key listener reads exactly one fact about a key press: its numeric key
--   code, to ask "is it the spacebar?". Nothing else is read from the event: not
--   the character, not the modifiers, not the app. Nothing is stored in a
--   variable, written to a file or log, or sent anywhere, for any key. The
--   listener always returns false, so every key press goes on to the app
--   untouched. Read the function below: it is short on purpose.
--
-- Needs, granted once in System Settings > Privacy & Security:
--   Accessibility and Input Monitoring, for Hammerspoon.

local MW_HOME = debug.getinfo(1, "S").source:match("^@(.*)/hammerspoon/init%.lua$")
  or (os.getenv("HOME") .. "/mac-watch")
local TRIGGER = MW_HOME .. "/bin/trigger.sh"

-- keep references at module level so nothing is garbage-collected
MacWatch = MacWatch or {}
MacWatch.pending = {}

-- Run bin/trigger.sh <reason>, optionally after a short delay (a freshly woken
-- Mac needs a moment before the screen and network are ready).
local function fire(reason, delaySec)
  local function run()
    hs.task.new("/bin/sh", function() end, { TRIGGER, reason }):start()
  end
  if not delaySec then
    run()
    return
  end
  local t
  t = hs.timer.doAfter(delaySec, function()
    run()
    MacWatch.pending[t] = nil
  end)
  MacWatch.pending[t] = true
end

-- ---------------------------------------------------------------- spacebar --

local SPACE_KEYCODE = hs.keycodes.map["space"]
local SPACE_SETTLE_SEC = 3     -- take the shot this long after the last space...
local SPACE_MAX_WAIT_SEC = 30  -- ...but never wait longer than this during endless typing
local burstStart = nil         -- when the current burst of spaces began (a timestamp, not a key)

-- Restarts on every call: it only fires once the spaces have stopped for
-- SPACE_SETTLE_SEC. It holds no key data, only a timer.
MacWatch.spaceSettle = hs.timer.delayed.new(SPACE_SETTLE_SEC, function()
  burstStart = nil
  fire("space")
end)

local function spacePressed()
  local now = hs.timer.secondsSinceEpoch()
  if burstStart == nil then
    burstStart = now
  end
  if now - burstStart >= SPACE_MAX_WAIT_SEC then
    -- typing without a pause for a long time: take a shot now anyway
    burstStart = now
    MacWatch.spaceSettle:stop()
    fire("space")
  else
    MacWatch.spaceSettle:start()
  end
end

-- The ONLY place a key press is looked at. It compares the key code with the
-- spacebar's and ignores auto-repeat. It returns false in every case so the key
-- is never swallowed.
local function onKeyDown(event)
  if event:getKeyCode() ~= SPACE_KEYCODE then
    return false
  end
  if event:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) ~= 0 then
    return false
  end
  spacePressed()
  return false
end

MacWatch.spaceTap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, onKeyDown)
MacWatch.spaceTap:start()

-- macOS switches an event tap off if the callback is ever slow; switch it back on
MacWatch.tapGuard = hs.timer.doEvery(10, function()
  if not MacWatch.spaceTap:isEnabled() then
    MacWatch.spaceTap:start()
  end
end)

-- ------------------------------------------------------- wake / lock / unlock --

local w = hs.caffeinate.watcher
MacWatch.sleepWatcher = w.new(function(event)
  if event == w.systemDidWake or event == w.screensDidWake then
    fire("wake", 3)
  elseif event == w.screensDidLock then
    fire("lock")
  elseif event == w.screensDidUnlock then
    fire("unlock", 2)
  end
end)
MacWatch.sleepWatcher:start()

-- ------------------------------------------------------------------- housekeeping --

hs.autoLaunch(true)            -- start Hammerspoon at login
hs.accessibilityState(true)    -- ask for Accessibility permission if missing

print("mac-watch: Hammerspoon triggers loaded (" .. TRIGGER .. ")")
