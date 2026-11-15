# mac-watch

A small, free, unattended utility for one MacBook (macOS 26 Tahoe), for its owner only.

While the lid is open it takes a screenshot every 5 minutes and uploads it to a private
Backblaze B2 bucket. If the Mac is offline the shots queue on disk and upload when the internet
returns. A small web page (a free Cloudflare Worker, signed in with your Google account) shows
whether the Mac is alive and lets you take a screenshot now, watch a live view, start a screen
recording, pause, change settings, browse and download shots on your phone, delete old ones and
watch the storage used. Optionally the spacebar (taken 3 seconds after you stop typing, so it
shows what you just typed), waking up, and locking/unlocking also take a shot.

Everything is free and no payment card is attached anywhere (Backblaze: 10 GB free; Cloudflare
Workers + D1 free plan). A storage guard deletes the oldest shots before the 10 GB is reached.

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
Backblaze B2 bucket macwatch-twjdnu (private)
  shots/2026-11-13/20261113-152800-interval.jpg    every 5 min
                   20261113-152905-space.jpg       spacebar
                   20261113-153012-remote.jpg      "Screenshot now" on the web page
  thumbs/2026-11-13/...                            320 px copies for the web page's grids
  recordings/2026-11-13/20261113-153100-rec.mov    Record button
  keep/2026-11-13/...                              what you tapped Keep on: never deleted automatically
  live/...                                         live-view frames, gone after a day
```

The word before `.jpg` says **why** the shot exists: `interval`, `login`, `remote`,
`space`, `wake`, `lock`, `unlock`.

Shots and recordings older than `RETENTION_DAYS` (14, changeable on the web page) are deleted by
the Worker. Above `STORAGE_SOFT_LIMIT_GB` (8 GB) it deletes the oldest days first. `keep/` is never
touched by either.

## Install on the Mac

You need [Homebrew](https://brew.sh). Everything else ships with macOS.

```sh
brew install rclone
git clone <your private repo> ~/mac-watch      # or, if you already have it: cd ~/mac-watch && git pull
cd ~/mac-watch
./bin/setup-remote.sh     # asks for the Mac's Backblaze key (hidden), makes the Mac token, prints its hash
./bin/install.sh          # writes and loads the LaunchAgents
```

`setup-remote.sh` prints a **hash** of the new Mac token (not the token). On the laptop, in the
repo, run `./worker/put-secrets.sh MAC_TOKEN_HASH` and paste it; then run `./bin/setup-remote.sh`
on the Mac again and it should say the Worker accepts the Mac.

Then do these two things, in this order:

1. **Screen Recording permission.** System Settings, Privacy & Security, *Screen & System
   Audio Recording*, press **+**, press Cmd+Shift+G, type `/bin/sh`, Open, switch it on.
   (If shots are still wallpaper-only, run `./bin/install.sh --wrapper` and grant
   **MacWatch** instead; that builds a tiny named app, which macOS often handles better.)
2. **Background items.** macOS may show "Background Items Added". If asked, allow them. If
   they are off in System Settings, General, *Login Items & Extensions*, nothing runs.

Then run `./bin/selftest.sh`. It opens a test screenshot and asks you to confirm you see
your real windows, checks Backblaze and the Worker, asks you to press **Screenshot now** on your
phone, tests the stop switch, and prints PASS or FAIL. If anything fails, run
`./bin/diagnose.sh` and paste the output back to Claude. It prints no secrets.

### Keys and secrets (where each one lives)

| What | Where | Who can read it |
|---|---|---|
| Mac's Backblaze key (`macwatch-mac`) | rclone config on the Mac (plain text, as rclone always stores B2 keys), `chmod 600` | you |
| Mac token | `~/mac-watch/.mac-token`, `chmod 600`, git-ignored | you; the Worker only has its SHA-256 |
| Worker's Backblaze key (`macwatch-worker`), session secret, allowed e-mail, Google client ID | Cloudflare Worker secrets (`./worker/put-secrets.sh`) | the Worker |
| Your browser session | an `HttpOnly; Secure; SameSite=Strict` cookie, 14 days | nobody, not even the page's JavaScript |

Both Backblaze keys are limited to the one bucket. Nothing is ever printed, logged or committed.
Sign out on the web page signs out **every** device.

## Using it

| I want to | Do this |
|---|---|
| See what it is doing | the web page, or `./bin/status.sh` on the Mac |
| Stop everything instantly | `touch ~/mac-watch/PAUSE` (nothing captures, records, uploads or even talks to the Worker) |
| Resume | `rm ~/mac-watch/PAUSE` |
| Instant screenshot from my phone | web page, **Screenshot now** (shows up in about 3 to 10 s while the page is open) |
| See the screen right now | **Live view**: a small frame every 4 s, stops 10 minutes after you close the page |
| Screen recording from my phone | **Record** (length = `RECORD_SEC`, default 5 min) |
| Pause remotely / resume | **Pause** / **Resume**. A local `PAUSE` file is stronger and only the Mac can lift it |
| Download one screenshot to my phone | **Files**, pick a day, tap the shot, **Download** |
| Keep something forever | **Keep** in the viewer, or long-press to select several |
| Free up space | **Files > Clean up** (older than N days) or **Delete this day**; it shows the count and MB first |
| Watch the storage | **Storage**: used of 10 GB, per day, growth, days until the guard, the Mac's free disk |
| Copy things to my other laptop | `./bin/archive-pull.sh` there (see **Archive** below) |
| Remove it | `./bin/uninstall.sh` (keeps your data; `--purge` also deletes local queue/logs) |

**Commands from the page** are queued on the Worker; the Mac asks for them every 20 s (every 2 s
while the page is open). Each runs at most once, and one older than `MARKER_MAX_AGE_MIN` (30 min)
is dropped, so a command sent while the Mac slept does not fire hours later (pause/resume always
apply). A sleeping Mac, a closed lid or a `PAUSE` file means nothing happens: the page then says
"last seen X ago".

**Recording** is screen only: no audio, no camera. If the lid closes or `PAUSE` appears
mid-recording it stops and keeps what it has.

## The web page

`https://butter-bot.butter-bot-worker.workers.dev` (a Cloudflare Worker, free plan). Sign in with
Google; only the e-mail stored as `ALLOWED_EMAIL` gets in. Bytes live in Backblaze and are
streamed through the Worker (no Backblaze key ever reaches the browser); everything small (file
list, commands, status, settings) lives in Cloudflare D1. Details, deploying and the secrets:
`web/README.md`.

Settings changed there reach the Mac with the next poll, but **only** a fixed list of numbers
within fixed ranges (never paths, commands or flags), and the Mac checks them again against its
own table. `./bin/status.sh` shows when settings from the page are active.

## Archive

Shots stay for `RETENTION_DAYS` (14). To keep things longer: tap **Keep** (moves them into
`keep/`, never pruned), then on your other laptop (needs rclone, this repo and a third Backblaze
key, read access is enough: `./bin/setup-remote.sh --rclone-only`):

```sh
./bin/archive-pull.sh                    # copy keep/ to ~/mac-watch-archive
./bin/archive-pull.sh --all --days 3     # also everything from the last 3 days
./bin/archive-pull.sh --free-remote      # after a VERIFIED copy, delete from Backblaze (asks first)
```

Without `--free-remote` nothing is ever deleted.

## Settings (`config.env`)

Plain `KEY=value`. Most are read live. After changing `INTERVAL_SEC` or `CONTROL_POLL_SEC`
run `./bin/install.sh` again (those are written into the LaunchAgents).

| Setting | Default | Meaning |
|---|---|---|
| `INTERVAL_SEC` | 300 | seconds between automatic shots |
| `MAX_WIDTH`, `JPEG_QUALITY` | 1440, 60 | screenshot size/quality (small screens are never enlarged) |
| `SCREENCAPTURE_EXTRA` | empty | e.g. `-m` for main display only |
| `SKIP_IDENTICAL`, `SKIP_MAX_AGE_SEC` | 1, 3600 | skip an interval shot if the screen did not change, but never go longer than an hour without one |
| `RCLONE_REMOTE`, `B2_BUCKET` | b2, macwatch-twjdnu | where to upload |
| `WORKER_URL` | the workers.dev address | the web page and the Mac's command channel |
| `RETENTION_DAYS` | 14 | (set on the web page) the Worker deletes older shots |
| `QUEUE_MAX_FILES`, `QUEUE_MAX_MB` | 2000, 2000 | local cap while offline; oldest deleted first and logged |
| `KEEP_AWAKE` | 0 | `1` = hold `caffeinate -di` while the lid is open |
| `CONTROL_POLL_SEC` | 60 | upload job interval |
| `MARKER_MAX_AGE_MIN` | 30 | older commands from the page are ignored |
| `RECORD_SEC` | 300 | recording length |
| `UPLOAD_EVERY_SEC` | 300 | shots are batched: uploaded together at most this often (immediately after the network returns, and for Screenshot now) |
| `SPACE_MIN_GAP_SEC`, `EVENT_MIN_GAP_SEC` | 30, 30 | at most one spacebar / wake / lock shot per this many seconds |

**Decisions made while you were away** (the three "open" questions): `KEEP_AWAKE` is **off**,
so the Mac sleeps as normal and a sleeping Mac captures nothing. Turn it on in `config.env` if
you want it awake with the lid open (more battery use; it uses `caffeinate`, which changes no
system settings). Several displays are handled by macOS `screencapture`'s default; the
selftest tells you how many displays it sees and you can set `SCREENCAPTURE_EXTRA=-m` for the
main one only. "Record" means **screen video only**.

## How it works

Four LaunchAgents (they need your logged-in graphical session, so they are Agents, not Daemons):

| Agent | Runs | Job |
|---|---|---|
| `com.macwatch.capture` | at login and every `CONTROL_POLL_SEC` | `trigger.sh interval`, which takes a shot only once `INTERVAL_SEC` has passed (so the interval can be changed live) |
| `com.macwatch.upload` | at login, every `CONTROL_POLL_SEC`, and when the network config changes | queue cap, batch upload to B2, tell the Worker what arrived |
| `com.macwatch.listen` | always (KeepAlive) while logged in | polls the Worker: commands, settings, live view, status |
| `com.macwatch.record` | only when asked | `record.sh`, started by `listen.sh` for Record |

The record agent exists because a 5-minute recording cannot live inside a polling loop,
and a recorder started in the background by a script cannot be stopped cleanly.

**One gate.** Everything goes through `gate()` in `bin/lib.sh`: no `PAUSE` file, and lid open
(`ioreg ... AppleClamshellState = No`; if that key is missing the lid is treated as open and
this is logged once). **One entry point**: every trigger calls `bin/trigger.sh <reason>`,
which applies a per-reason debounce, then `capture.sh`.

Capture: `screencapture`, shrunk with `sips` (plus a 320 px thumbnail), written to `tmp/`, then
renamed into `queue/` so the uploader never sees a half-written file. Upload: one `rclone move`
to B2 (the local file is deleted only after a verified upload), then `POST /mac/index` so the
page lists it (kept in `state/index-pending` until the Worker confirms). Offline: the shot just
waits in `queue/`.

Failures are loud: `ERROR` in `log/upload.log` or `log/listen.log` and shown by `status.sh`,
with the fix (`./bin/setup-remote.sh`, or `./worker/put-secrets.sh MAC_TOKEN_HASH`).

### Triggers

| Trigger | How | |
|---|---|---|
| Every 5 min, login | launchd | built |
| Lid open/closed gate | `ioreg` | built |
| Screenshot now, Record, Live, Pause/Resume | web page -> Worker -> `listen.sh` poll (2 s while the page is open) | built |
| Internet comes back | the upload job polls, plus `WatchPaths` on network config | built |
| Spacebar (3 s after you stop typing), wake, lock, unlock | Hammerspoon (below) | built, optional |
| Return / keypad Enter: a shot on **every** press, at once (presses under 0.5 s apart count once) | Hammerspoon (below) | built, optional |
| Charger unplugged | logged in `log/events.log` | built |
| Heartbeat (battery, power, Wi-Fi, uptime) | one line per interval shot in `log/events.log` | built |
| Screen unchanged | interval shot skipped by a hash of a 16x16 copy | built |

### Hammerspoon triggers (optional)

```sh
brew install --cask hammerspoon
./bin/install.sh --hammerspoon      # asks before adding ONE line to ~/.hammerspoon/init.lua
```

Open Hammerspoon, grant **Accessibility** and **Input Monitoring**, choose *Reload Config*.
`--hammerspoon` also installs a fourth LaunchAgent that opens Hammerspoon at every login, and
while it is enabled mac-watch starts Hammerspoon again within a minute if it is not running.
Undo with `./bin/install.sh --no-hammerspoon`.

**This is not a keylogger.** The key listener (`hammerspoon/init.lua`, one short function)
reads exactly one fact about a key press: its numeric key code, to ask "is this the
spacebar or Enter?". It does not read the character, modifiers or app, stores nothing, writes no log
and sends nothing, and it never swallows a key. `tests/hs_mock.lua` enforces this: the fake key
event raises an error if the listener asks for anything else.

If Hammerspoon turns out flaky, a lighter fallback needs no extra permission: poll idle time
(`ioreg -c IOHIDSystem | grep HIDIdleTime`) and trigger on any keyboard or mouse activity.
Say the word and it can be added.

## Free limits

| Service | Free allowance (check current terms) | How mac-watch stays inside it |
|---|---|---|
| Backblaze B2 storage | 10 GB | storage guard at 8 GB (setting), retention 14 days, thumbnails for grids |
| B2 downloads (class B) | 2,500 calls/day | thumbnails cached by the browser for a year; the page shows today's estimate |
| B2 list/authorize/copy (class C) | 2,500 calls/day | the file list is in D1, not listed from B2; one rclone run per batch; Worker auth cached 23 h |
| Cloudflare Workers | 100,000 requests/day | about 4,300/day idle polling, about 300 per 10 min with the page open |
| Cloudflare D1 | free plan | at most one write per poll |

If Backblaze ever refuses because a daily cap is reached, uploads pause for an hour and retry.

## Problems

- **Shots show only the wallpaper**: Screen Recording permission. See Install, step 1, then
  `./bin/selftest.sh`. macOS also re-asks for approval from time to time; if shots go blank
  weeks later, that is the first suspect.
- **Nothing happens after login**: System Settings, General, Login Items & Extensions, make
  sure the mac-watch items are allowed. `./bin/status.sh` shows whether the agents are loaded.
- **Upload says AUTH PROBLEM**: the Mac's Backblaze key. `rclone config delete b2`, then
  `./bin/setup-remote.sh`.
- **Web page says "The Mac has not connected yet"** or `status.sh` says the Worker is REFUSING:
  the token hash. On the laptop `./worker/put-secrets.sh MAC_TOKEN_HASH`, paste the hash that
  `./bin/setup-remote.sh` prints on the Mac.
- **Anything else**: `./bin/diagnose.sh`, paste the output. Logs are in `log/` (about 1 MB each).

## For developers (Linux)

Development happens on Linux; the Mac-only commands are stubbed in `tests/stubs/`.

```sh
make check     # dash -n, shellcheck -s sh, lua + js syntax, then tests under dash and bash --posix
make deploy    # the Worker + web page (cd worker && npm install && npx wrangler login, once)
make dist      # dist/mac-watch.tar.gz
```

POSIX `sh` only (macOS has bash 3.2 and a BSD userland: no `sed -i`, `date -d`, `stat -c`,
`readlink -f`, `xargs -r`, `grep -P`). The shell tests run the real Mac scripts with real curl
against the real Worker code (`tests/fake_worker.mjs`: node:sqlite stands in for D1, a folder for
B2). If real `rclone` is installed, the upload and archive logic also runs against rclone's local
backend. The Worker has its own node tests (`tests/worker_test.mjs`).

Layout:

```
bin/lib.sh        config, logging, lid_open(), gate(), locks
bin/trigger.sh    gate + debounce + capture          bin/capture.sh   one screenshot
bin/record.sh     screen recording                   bin/upload.sh    upload to B2, index, queue cap
bin/listen.sh     poll the Worker (commands, live)   bin/api.sh       curl wrapper for the Worker
bin/report.sh     status.json for the page           bin/setup-remote.sh  B2 key + Mac token
bin/status.sh     bin/diagnose.sh  bin/selftest.sh   bin/install.sh   bin/uninstall.sh
bin/archive-pull.sh  bin/make-wrapper.sh  bin/heartbeat.sh
worker/           Cloudflare Worker (core.js, b2.js, schema.sql, wrangler.toml, put-secrets.sh)
web/              the web page (served by the Worker)
hammerspoon/init.lua    tests/run.sh  tests/stubs/    config.env
queue/ tmp/ log/ state/ PAUSE    runtime data, not in git
```
