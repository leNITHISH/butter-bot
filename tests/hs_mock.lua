-- Runs hammerspoon/init.lua against a fake `hs` and checks its behaviour.
-- The fake key event ONLY answers getKeyCode() and getProperty(autorepeat);
-- any other method call (reading characters, flags...) raises an error.
local tasks, taps, watchers, timers = {}, {}, {}, {}
local now = 1000
local autorepeat = 0

local function key_event(code, rep)
  return setmetatable({}, { __index = function(_, name)
    if name == "getKeyCode" then return function() return code end end
    if name == "getProperty" then return function(_, prop)
      assert(prop == "autorepeat-prop", "listener read an unexpected property: " .. tostring(prop))
      return rep end end
    error("PRIVACY VIOLATION: listener called event:" .. tostring(name))
  end })
end

hs = {
  keycodes = { map = { space = 49 } },
  eventtap = { event = { types = { keyDown = "keyDown" }, properties = { keyboardEventAutorepeat = "autorepeat-prop" } },
    new = function(types, fn)
      assert(#types == 1 and types[1] == "keyDown", "must listen to keyDown only")
      local t = { fn = fn, on = false }
      t.start = function(self) self.on = true end
      t.isEnabled = function(self) return self.on end
      taps[#taps + 1] = t
      return t
    end },
  task = { new = function(path, cb, args)
    assert(path == "/bin/sh")
    return { start = function() tasks[#tasks + 1] = args end }
  end },
  timer = { secondsSinceEpoch = function() return now end,
    doAfter = function(sec, fn) local t = { sec = sec, fn = fn }; timers[#timers + 1] = t; return t end,
    doEvery = function(sec, fn) return { sec = sec, fn = fn } end },
  caffeinate = { watcher = { systemDidWake = 1, screensDidWake = 2, screensDidLock = 3, screensDidUnlock = 4,
    new = function(fn) local w = { fn = fn }; w.start = function() end; watchers[#watchers + 1] = w; return w end } },
  autoLaunch = function() end,
  accessibilityState = function() end,
}
local original_print = print
print = function() end

local path = arg[1]
dofile(path)
print = original_print

local failures = 0
local function check(cond, msg) if cond then print("  ok   " .. msg) else failures = failures + 1; print("  FAIL " .. msg) end end

local tap = taps[1]
check(tap.on, "event tap started")

tap.fn(key_event(0, 0))
check(#tasks == 0, "other keys do nothing")
local ret = tap.fn(key_event(49, 0))
check(#tasks == 1 and tasks[1][2] == "space", "spacebar runs trigger.sh space")
check(ret == false, "listener never swallows a key")
check(tasks[1][1]:match("/bin/trigger%.sh$") ~= nil, "runs bin/trigger.sh")
tap.fn(key_event(49, 1))
check(#tasks == 1, "auto-repeat ignored")
tap.fn(key_event(49, 0))
check(#tasks == 1, "second press within 5 s is rate-limited locally")
now = now + 6
tap.fn(key_event(49, 0))
check(#tasks == 2, "press after the local gap runs again")

local w = watchers[1]
w.fn(1)
check(#timers == 1 and timers[1].sec == 3, "wake is scheduled after 3 s")
timers[1].fn()
check(tasks[#tasks][2] == "wake", "wake runs trigger.sh wake")
w.fn(3)
check(tasks[#tasks][2] == "lock", "lock runs trigger.sh lock")
w.fn(4)
timers[2].fn()
check(tasks[#tasks][2] == "unlock", "unlock runs trigger.sh unlock")

tap.on = false
-- the guard timer re-enables a disabled tap
local guard = MacWatch.tapGuard
guard.fn()
check(tap.on, "guard timer restarts a disabled tap")

os.exit(failures == 0 and 0 or 1)
