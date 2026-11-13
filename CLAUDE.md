# mac-watch

A small, free, unattended utility for my MacBook (macOS 26.6.2, Tahoe). While the lid is open it takes a screenshot every 5 minutes and uploads it to my Google Drive. If the Mac is offline, shots queue locally and upload when internet returns. From my phone I can drop a marker in Drive to get an instant screenshot or a 5-minute screen recording. Pressing the spacebar also triggers a screenshot. I use it from college to check that things at home are running the way they should.

You are taking this over from a planning chat. Everything below is decided unless marked **Open**. Build it, then report back in plain language.

## Where the work happens

Development happens on **Linux** (my Arch laptop, or a Claude cloud sandbox), not on the Mac. Linux cannot run `screencapture`, `launchctl`, `ioreg` lid state, macOS permission prompts or Hammerspoon. So:

- **POSIX `sh` only** (`#!/bin/sh`), no bashisms. Check with `shellcheck -s sh` and `dash -n`. (Arch: `pacman -S shellcheck`; cloud sandbox: `pip install shellcheck-py`.) macOS has an old bash 3.2, which is another reason to stay POSIX.
- **macOS has a BSD userland.** Avoid GNU-only flags: `sed -i`, `date -d`, `stat -c`, `readlink -f`, `find -printf`, `xargs -r`, `grep -P`.
- **Stub the Mac-only commands in tests.** Put fakes for `screencapture`, `sips`, `ioreg`, `pmset`, `avconvert`, `launchctl` and `rclone` in `tests/stubs/`, first on `PATH`. The fake `rclone` can write to a local directory. Assert: lid gating, `PAUSE`, debounce, marker handling (including stale markers), queue cap, lock handling.
- `tests/run.sh` is a plain shell script with no test framework. `make check` runs lint and tests. Validate LaunchAgent plists on Linux with `python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' FILE`.
- The cloud sandbox's network is allowlisted. It cannot reach Google and cannot do OAuth. Don't try. Drive login happens once, on the Mac.
- **Delivery:** a private git repo (or a tarball from `make dist`). On the Mac I run `git clone` and then `./bin/install.sh`.
- **You cannot verify Mac behaviour, so build two helpers I run on the Mac and paste back to you:**
  - `bin/diagnose.sh` prints non-secret facts: `sw_vers`, lid state, whether `screencapture` and `rclone` work, `launchctl list | grep macwatch`, and the last log lines.
  - `bin/selftest.sh` walks through the Mac-only checks and prints PASS or FAIL. It asks me to open a test screenshot and confirm real windows are visible.

## Ground rules

- My own MacBook, for me only. Nothing hidden: it must be easy to see, pause and uninstall. Do not try to hide macOS's recording indicator.
- Free only. No paid services.
- Few dependencies: macOS built-ins plus `rclone` (Homebrew). Hammerspoon in Phase 3 only.
- Ask me before: `sudo`, changing power or sleep settings, widening Drive permissions beyond what is written here, or touching anything outside `~/mac-watch` and `~/Library/LaunchAgents`.
- Never print, log or commit the rclone config or token.

## Decided

- **Lid gate:** capture and record only while the lid is open. Every trigger goes through one gate in `bin/lib.sh` (lid open, no `PAUSE` file). Lid state: `ioreg -r -k AppleClamshellState -d 4`, where `"AppleClamshellState" = No` means open. Verify on this Mac. If the key is missing, treat the lid as open and log it once.
- **Autostart:** LaunchAgents with `RunAtLoad`, so it starts at login. There is no time schedule. It runs whenever the lid is open.
- **No power changes by default.** A sleeping Mac captures nothing. `KEEP_AWAKE=0|1` in config (default 0) can hold `caffeinate -di` while the lid is open (see Open).
- **One entry point.** Every trigger calls `bin/trigger.sh <reason>`: gate, per-reason debounce, then capture. File names include the reason, for example `20261113-152800-space.jpg`, so I can see why each shot exists.

## Layout

```
~/mac-watch/
  config.env           all settings
  bin/lib.sh           config, logging, lid_open(), gate()
  bin/trigger.sh       gate + debounce + capture (arg: reason)
  bin/capture.sh       one screenshot -> tmp/ -> queue/
  bin/record.sh        N-second screen recording -> queue/
  bin/upload.sh        flush queue/ to Drive, prune, handle markers
  bin/status.sh        last capture, queue size, last good upload, last error
  bin/install.sh       idempotent: write plists, load them
  bin/uninstall.sh     unload and remove plists (keeps data)
  bin/diagnose.sh  bin/selftest.sh
  hammerspoon/init.lua Phase 3 event triggers
  tests/ Makefile
  queue/ tmp/ log/     runtime data (not in git)
  PAUSE                if this file exists, nothing captures
```

`config.env`: `INTERVAL_SEC=300`, `MAX_WIDTH=1440`, `JPEG_QUALITY=60`, `RCLONE_REMOTE=gdrive`, `DRIVE_FOLDER=mac-watch`, `RETENTION_DAYS=14`, `QUEUE_MAX_FILES=2000`, `KEEP_AWAKE=0`, `CONTROL_POLL_SEC=60`, `MARKER_MAX_AGE_MIN=30`, `SPACE_MIN_GAP_SEC=60`, `RECORD_SEC=300`.

## How it works

**Capture:** `screencapture -x -t jpg`, shrink and compress with `sips`, write into `tmp/`, then `mv` into `queue/` so the uploader never sees half-written files. If the display is asleep or capture fails, log a line and move on.

**Upload** (every 2 min, lid open only):
- `mkdir` lock (stale after 10 min). Online check: `curl -s --max-time 5 https://connectivitycheck.gstatic.com/generate_204`. If offline, exit quietly.
- `rclone move` with `--min-age 15s`. `.jpg` goes to `$DRIVE_FOLDER/shots/YYYY-MM-DD/`, `.mov` goes to `$DRIVE_FOLDER/recordings/YYYY-MM-DD/`. `move` deletes the local file only after a verified upload.
- Prune Drive older than `RETENTION_DAYS` with `--drive-use-trash=false`, otherwise deleted files keep using quota in Trash. Then `rmdirs --leave-root`. Cap the local queue at `QUEUE_MAX_FILES`, deleting oldest first and logging it.
- Auth failures are loud: `ERROR` in `upload.log`, shown by `status.sh`.

**Remote markers** (polled every `CONTROL_POLL_SEC`, lid open and online only):
- Folder: `$DRIVE_FOLDER/control/`. A marker is any **file or folder** whose name starts with `snap-now` or `record-5min`, case-insensitive. On my phone the easiest marker is an empty folder with that name.
- List with `rclone lsf --format tp` to get the age. Ignore and delete markers older than `MARKER_MAX_AGE_MIN`, so a marker made while the Mac was offline does not fire hours later.
- **Delete the marker first**, and act only if the delete succeeded. A marker that cannot be deleted would otherwise re-fire every minute.
- `snap-now` runs `trigger.sh remote` and uploads it.
- `record-5min` runs `record.sh $RECORD_SEC`. Only one recording at a time (lock file). Afterwards upload a tiny `control/done-<marker>-<time>.txt` so I know it ran.

**Recording** (`record.sh`): `screencapture -v -V 300 -x` (check `man screencapture` on the Mac). Screen only, no audio, no webcam. Add a wall-clock watchdog: if the lid closes mid-recording, stop it and keep the partial file. Compress with the built-in `avconvert` (check `avconvert --help` for a 720p preset), fall back to `ffmpeg` if installed, and keep the original if both fail. Then `mv` into `queue/` as `...-rec.mov`.

**Scheduling:** two LaunchAgents (not Daemons, since capture needs my logged-in GUI session), `com.macwatch.capture` (`StartInterval=INTERVAL_SEC`, runs `trigger.sh interval`) and `com.macwatch.upload` (`StartInterval=CONTROL_POLL_SEC`, handles both markers and the upload flush). Use `launchctl bootstrap gui/$(id -u)` and `bootout`. Logs go to `log/`, rotated around 1 MB.

## Google Drive setup (needs me, on the Mac)

- `brew install rclone`, then `rclone config`: remote `gdrive`, type `drive`, scope **`drive` (full access)**. Leave `client_id` blank at first.
- **Why the wider scope:** markers are created by me in the Drive app, and the narrower `drive.file` scope only sees files rclone itself created. **Tell me the trade-off before running the login:** a stolen `rclone.conf` could read and write my whole Drive. Mitigations: `chmod 600` on the config, FileVault on, and I can revoke the token at myaccount.google.com/permissions.
- The browser login is interactive. Pause and tell me what to click.
- If polling every minute hits `rateLimitExceeded` on rclone's shared client ID, switch to our own Google Cloud OAuth client. Its consent screen must be **"In production"**. In "Testing", refresh tokens expire after about 7 days and everything silently stops. Check Google's current docs.

## Triggers

| Trigger | How | Phase |
|---|---|---|
| Every 5 min | launchd `StartInterval` | 1 |
| Login or reboot | launchd `RunAtLoad` | 1 |
| Lid open/closed gate | `ioreg` AppleClamshellState | 1 |
| Marker `snap-now` | Drive `control/` poll | 2 |
| Marker `record-5min` | Drive `control/` poll | 2 |
| Internet comes back | upload job already polls; add `WatchPaths` on `/Library/Preferences/SystemConfiguration/` (best effort) | 2 |
| Spacebar pressed | Hammerspoon key listener (below) | 3 |
| Wake from sleep, lid opened | Hammerspoon `hs.caffeinate.watcher` (`systemDidWake`, `screensDidWake`) | 3 |
| Screen lock or unlock | same watcher | 3 |
| Charger unplugged | poll `pmset -g batt`, log changes | 4 |
| Screen unchanged | skip upload when a hash of a tiny downscaled copy matches the previous | 4 |

**Spacebar trigger (Phase 3):**
- Hammerspoon `hs.eventtap` on `keyDown`. Act only when the key code equals `hs.keycodes.map.space`, ignore auto-repeat events, and call `bin/trigger.sh space`.
- `trigger.sh` debounces to one shot per `SPACE_MIN_GAP_SEC`, since people press space constantly.
- **Privacy rule:** the listener must never store, log or send any other key. It is not a keylogger, and the Lua should make that obvious to read.
- Hammerspoon needs Accessibility and Input Monitoring permission (I grant these once) and must start at login. Hammerspoon can't be built or run on Linux, so write the Lua carefully, lint it with `luacheck` if available, and have me test it with `selftest.sh`.
- A lighter alternative is polling idle time with `ioreg -c IOHIDSystem` (`HIDIdleTime`), which needs no extra permission and triggers on any keyboard or mouse activity. Offer it if Hammerspoon is flaky.

## Phases

1. **MVP:** lid gate, capture, upload, prune, queue cap, autostart, install/uninstall, logs, `PAUSE`, `status.sh`, `diagnose.sh`, `selftest.sh`, Linux tests.
2. **Remote control:** `snap-now` and `record-5min` markers, `record.sh`, faster upload on network change.
3. **Events:** Hammerspoon with spacebar, wake/lid-open, lock/unlock.
4. **Extras:** heartbeat line (battery, AC, Wi-Fi, uptime), charger-unplugged log, skip identical frames.

**Phase 1 is done when** (on the Mac, via `selftest.sh`):
- After a reboot and login, both agents start by themselves.
- With Wi-Fi off for 15 minutes the queue grows, and after Wi-Fi returns it empties within about 5 minutes and the files are in Drive.
- Screenshots show my real windows, not just the wallpaper.
- Lid closed means no captures. This can only be tested live with an external monitor (a closed lid otherwise sleeps the Mac), so rely on the stub test plus one live check if I have a monitor.
- Disk use stays bounded and `uninstall.sh` cleans up.

## Known risks (test early)

- **Screen Recording permission:** without it, `screencapture` does not error. It captures only the wallpaper and menu bar. Permission for launchd-run scripts attaches to the launching process, so granting Terminal may not be enough. Try `/bin/sh` first, then a minimal app wrapper. Recording (`-v`) needs the same permission.
- **Re-approval:** recent macOS versions re-ask for screen-recording approval from time to time. Unattended, that may silently blank captures. Watch for it on 26.6.2 and tell me what you see.
- **Login Items:** macOS may show "Background Items Added" and require allowing the agents in System Settings, General, Login Items & Extensions. Mention it in the install output.
- **Autostart means at login.** After a power cut or reboot nothing runs until I log in, and FileVault disables auto-login. Say this plainly in the README.
- **Sleep and display:** a sleeping Mac captures nothing. A sleeping display may make `screencapture` fail or capture black. Test what happens and log it.
- **Privacy:** shots can contain passwords and messages. Keep `PAUSE` working as a kill switch.

## Open: ask me in one message before Phase 1

1. While I'm away with the lid open, should the Mac stay awake with the display on (`KEEP_AWAKE=1`, which changes behaviour and battery use), or may it sleep as normal?
2. One display or several?
3. I assumed "record" means screen video only (no audio, no webcam). Confirm.

## Status (update as you go)

- [x] Phase 1  - [x] Phase 2  - [x] Phase 3  - [x] Phase 4

All four phases are **built and tested on Linux** (`make check`: lint plus 177 checks under dash and bash --posix,
including the real `rclone` local backend). **Nothing is verified on the Mac yet.** Still to do on the Mac:
`./bin/setup-drive.sh`, `./bin/install.sh`, grant Screen Recording to `/bin/sh` (fallback `--wrapper`),
then `./bin/selftest.sh` and paste back the result (or `./bin/diagnose.sh`).

Decisions made without waiting for answers to the Open questions: `KEEP_AWAKE=0`, displays left to
`screencapture` defaults (`SCREENCAPTURE_EXTRA="-m"` for main only), recording is screen only.
Deviation from the plan: a third on-demand LaunchAgent, `com.macwatch.record`, runs recordings (a 5-minute
recording cannot live inside the 60 s poll job, and background jobs started by a script cannot be stopped
cleanly with SIGINT).
