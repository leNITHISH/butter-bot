# mac-watch

A small, free, unattended utility for one MacBook (macOS 26 Tahoe), for its owner only.

While the lid is open it takes a screenshot every 5 minutes and uploads it to Google Drive.
If the Mac is offline the shots queue on disk and upload when the internet returns.
From a phone you can drop a marker into Drive to get an instant screenshot or a
5-minute screen recording. Optionally the spacebar, waking up, and locking/unlocking also
take a shot.

Nothing is hidden. It is easy to see (`status.sh`), pause (`touch PAUSE`) and remove
(`uninstall.sh`). macOS's own recording indicator is left alone.

> **Honest limits, up front**
>
> - It starts when you **log in**, not when the Mac boots. After a power cut or reboot
>   nothing runs until you log in. (FileVault turns automatic login off.)
> - A **sleeping Mac captures nothing**. By default mac-watch does not touch your power
>   settings. See `KEEP_AWAKE` below.
> - **Closed lid = no captures**, on purpose (it is part of the gate).
> - It needs **Screen Recording permission**. Without it macOS does *not* give an error:
>   screenshots silently show only the wallpaper. `./bin/selftest.sh` checks this with you.

## What gets captured, and where it goes

```
Google Drive/
  mac-watch/
    shots/2026-11-13/20261113-152800-interval.jpg    every 5 min
                     20261113-152905-space.jpg       spacebar
                     20261113-153012-remote.jpg      from your phone
    recordings/2026-11-13/20261113-153100-rec.mov    5-min recording
    control/                                         the markers you drop (see below)
```

The word before `.jpg` says **why** the shot exists: `interval`, `login`, `remote`,
`space`, `wake`, `lock`, `unlock`.

Files older than `RETENTION_DAYS` (14) are deleted from Drive permanently (not into the
Trash, which would keep eating your quota).

## Install on the Mac

You need [Homebrew](https://brew.sh). Everything else ships with macOS.

```sh
brew install rclone
git clone <your private repo> ~/mac-watch      # or: untar the output of `make dist` into ~/mac-watch
cd ~/mac-watch
./bin/setup-drive.sh      # one-time Google login (explains the trade-off first)
./bin/install.sh          # writes and loads the LaunchAgents
```

Then do these two things, in this order:

1. **Screen Recording permission.** System Settings, Privacy & Security, *Screen & System
   Audio Recording*, press **+**, press Cmd+Shift+G, type `/bin/sh`, Open, switch it on.
   (If shots are still wallpaper-only, run `./bin/install.sh --wrapper` and grant
   **MacWatch** instead; that builds a tiny named app, which macOS often handles better.)
2. **Background items.** macOS may show "Background Items Added". If asked, allow them. If
   they are off in System Settings, General, *Login Items & Extensions*, nothing runs.

Then run `./bin/selftest.sh`. It opens a test screenshot and asks you to confirm you see
your real windows, tests Drive, the phone markers and the stop switch, and prints PASS or FAIL.
If anything fails, run `./bin/diagnose.sh` and paste the output back to Claude. It prints
no secrets.

### Google Drive and the permission trade-off

`setup-drive.sh` creates an rclone remote named `gdrive` with scope **`drive` (full
access)**. Why: you create the phone markers yourself in the Drive app, and the narrower
`drive.file` scope can only see files rclone itself created, so it would never see them.

The cost: anyone who gets a copy of `~/.config/rclone/rclone.conf` can read and write your
**whole** Drive. What limits that: the script sets the file to `chmod 600`, keep FileVault
on, and you can revoke the token any time at <https://myaccount.google.com/permissions>.
The script explains this and asks you to type `yes` before anything happens.
mac-watch never prints, logs or commits the rclone config or token.

## Using it

| I want to | Do this |
|---|---|
| See what it is doing | `./bin/status.sh` |
| Stop everything instantly | `touch ~/mac-watch/PAUSE` (nothing captures, records or uploads) |
| Resume | `rm ~/mac-watch/PAUSE` |
| Instant screenshot from my phone | In the Drive app, in `mac-watch/control/`, create an **empty folder** named `snap-now` |
| 5-minute screen recording from my phone | Create an empty folder named `record-5min` |
| Remove it | `./bin/uninstall.sh` (keeps your data; `--purge` also deletes local queue/logs) |

**Markers.** Any file *or* folder in `control/` whose name starts with `snap-now` or
`record-5min` (any capitals, extra text is fine: `Snap-Now (2)` works). mac-watch checks every
minute while the lid is open and the Mac is online. It **deletes the marker first** and only
then acts, so a marker it cannot delete never fires over and over. A marker older than 30
minutes is deleted without acting, so one you made while the Mac was off does not go off hours
later. After a recording finishes, a small `control/done-record-5min-<time>.txt` appears so you
know it ran. A snapshot shows up in `shots/` within about a minute and a half.

**Recording** is screen only: no audio, no camera. If the lid closes or `PAUSE` appears
mid-recording it stops and keeps what it has.

## Settings (`config.env`)

Plain `KEY=value`. Most are read live. After changing `INTERVAL_SEC` or `CONTROL_POLL_SEC`
run `./bin/install.sh` again (those are written into the LaunchAgents).

| Setting | Default | Meaning |
|---|---|---|
| `INTERVAL_SEC` | 300 | seconds between automatic shots |
| `MAX_WIDTH`, `JPEG_QUALITY` | 1440, 60 | screenshot size/quality (small screens are never enlarged) |
| `SCREENCAPTURE_EXTRA` | empty | e.g. `-m` for main display only |
| `SKIP_IDENTICAL`, `SKIP_MAX_AGE_SEC` | 1, 3600 | skip an interval shot if the screen did not change, but never go longer than an hour without one |
| `RCLONE_REMOTE`, `DRIVE_FOLDER` | gdrive, mac-watch | where to upload |
| `RETENTION_DAYS` | 14 | delete older Drive files |
| `QUEUE_MAX_FILES`, `QUEUE_MAX_MB` | 2000, 2000 | local cap while offline; oldest deleted first and logged |
| `KEEP_AWAKE` | 0 | `1` = hold `caffeinate -di` while the lid is open |
| `CONTROL_POLL_SEC` | 60 | marker polling and upload job interval |
| `MARKER_MAX_AGE_MIN` | 30 | older markers are ignored |
| `RECORD_SEC` | 300 | recording length |
| `SPACE_MIN_GAP_SEC`, `EVENT_MIN_GAP_SEC` | 60, 30 | at most one spacebar / wake / lock shot per this many seconds |

**Decisions made while you were away** (the three "open" questions): `KEEP_AWAKE` is **off**,
so the Mac sleeps as normal and a sleeping Mac captures nothing. Turn it on in `config.env` if
you want it awake with the lid open (more battery use; it uses `caffeinate`, which changes no
system settings). Several displays are handled by macOS `screencapture`'s default; the
selftest tells you how many displays it sees and you can set `SCREENCAPTURE_EXTRA=-m` for the
main one only. "Record" means **screen video only**.

## How it works

Three LaunchAgents (they need your logged-in graphical session, so they are Agents, not Daemons):

| Agent | Runs | Job |
|---|---|---|
| `com.macwatch.capture` | at login and every `INTERVAL_SEC` | `trigger.sh interval` |
| `com.macwatch.upload` | at login, every `CONTROL_POLL_SEC`, and when the network config changes | markers, upload, prune |
| `com.macwatch.record` | only when asked | `record.sh`, started by the upload job for `record-5min` |

The third exists because a 5-minute recording cannot live inside a 60-second polling job,
and a recorder started in the background by a script cannot be stopped cleanly.

**One gate.** Everything goes through `gate()` in `bin/lib.sh`: no `PAUSE` file, and lid open
(`ioreg ... AppleClamshellState = No`; if that key is missing the lid is treated as open and
this is logged once). **One entry point**: every trigger calls `bin/trigger.sh <reason>`,
which applies a per-reason debounce, then `capture.sh`.

Capture: `screencapture`, shrunk with `sips`, written to `tmp/`, then renamed into
`queue/` so the uploader never sees a half-written file. Upload: `rclone move` (the local file
is deleted only after a verified upload). Offline: the shot just waits in `queue/`.

Auth failures are loud: `ERROR` in `log/upload.log` and shown by `status.sh`, with the fix
(`rclone config reconnect gdrive:`).

### Triggers

| Trigger | How | |
|---|---|---|
| Every 5 min, login | launchd | built |
| Lid open/closed gate | `ioreg` | built |
| Phone markers `snap-now`, `record-5min` | Drive `control/` poll | built |
| Internet comes back | the upload job polls, plus `WatchPaths` on network config | built |
| Spacebar, wake, lock, unlock | Hammerspoon (below) | built, optional |
| Charger unplugged | logged in `log/events.log` | built |
| Heartbeat (battery, power, Wi-Fi, uptime) | one line per interval shot in `log/events.log` | built |
| Screen unchanged | interval shot skipped by a hash of a 16x16 copy | built |

### Hammerspoon triggers (optional)

```sh
brew install --cask hammerspoon
./bin/install.sh --hammerspoon      # asks before adding ONE line to ~/.hammerspoon/init.lua
```

Open Hammerspoon, grant **Accessibility** and **Input Monitoring**, choose *Reload Config*.
Hammerspoon starts at login by itself after that.

**This is not a keylogger.** The key listener (`hammerspoon/init.lua`, one short function)
reads exactly one fact about a key press: its numeric key code, to ask "is this the
spacebar?". It does not read the character, modifiers or app, stores nothing, writes no log
and sends nothing, and it never swallows a key. `tests/hs_mock.lua` enforces this: the fake key
event raises an error if the listener asks for anything else.

If Hammerspoon turns out flaky, a lighter fallback needs no extra permission: poll idle time
(`ioreg -c IOHIDSystem | grep HIDIdleTime`) and trigger on any keyboard or mouse activity.
Say the word and it can be added.

## Rate limits and the Google OAuth client

rclone's built-in Google client ID is shared by everyone, and polling every minute can hit
`rateLimitExceeded` (it shows in `log/upload.log` and `selftest.sh`; mac-watch then pauses
Drive calls for 5 minutes and retries). The permanent fix is your own OAuth client:

```sh
./bin/setup-oauth.sh
```

It prints the Google Cloud Console steps (create a project, enable the Drive API, make a
*Desktop app* OAuth client), asks you to paste the client ID and secret, stores them in rclone's
config and re-runs the login. **Publish the consent screen as "In production"**: in "Testing"
status Google expires refresh tokens after about 7 days and everything silently stops.
(Check Google's current documentation; this has changed before.)

## Problems

- **Shots show only the wallpaper**: Screen Recording permission. See Install, step 1, then
  `./bin/selftest.sh`. macOS also re-asks for approval from time to time; if shots go blank
  weeks later, that is the first suspect.
- **Nothing happens after login**: System Settings, General, Login Items & Extensions, make
  sure the mac-watch items are allowed. `./bin/status.sh` shows whether the agents are loaded.
- **Upload says AUTH PROBLEM**: `rclone config reconnect gdrive:`.
- **Anything else**: `./bin/diagnose.sh`, paste the output. Logs are in `log/` (about 1 MB each).

## For developers (Linux)

Development happens on Linux; the Mac-only commands are stubbed in `tests/stubs/`.

```sh
make check     # dash -n, shellcheck -s sh, lua syntax, then tests under dash and bash --posix
make dist      # dist/mac-watch.tar.gz
```

POSIX `sh` only (macOS has bash 3.2 and a BSD userland: no `sed -i`, `date -d`, `stat -c`,
`readlink -f`, `xargs -r`, `grep -P`). If real `rclone` is installed, the tests also run
the marker/upload/prune logic against it using rclone's local backend.

Layout:

```
bin/lib.sh        config, logging, lid_open(), gate(), locks
bin/trigger.sh    gate + debounce + capture          bin/capture.sh   one screenshot
bin/record.sh     screen recording                   bin/upload.sh    markers, upload, prune, queue cap
bin/status.sh     bin/diagnose.sh  bin/selftest.sh   bin/install.sh   bin/uninstall.sh
bin/setup-drive.sh  bin/setup-oauth.sh  bin/make-wrapper.sh  bin/heartbeat.sh
hammerspoon/init.lua    tests/run.sh  tests/stubs/    config.env
queue/ tmp/ log/ state/ PAUSE    runtime data, not in git
```
