# PLAN.md

Decisions by the owner so far (2026-11-15): **Cloudflare R2 is out** (needs a payment card, none available);
**Google Drive is being dropped completely** (too slow to sync, poor for remote control); the goal is a
**mild remote monitor**: on-demand screenshot, live-ish view, status, recordings, pause, settings.

- **Part A** is a handoff note for a *different* Claude Code (on the owner's Arch machine, with Chrome)
  to publish the Google OAuth app. **Probably no longer needed**: see its banner.
- **Part B** is the plan: Backblaze B2 (files) + a free Cloudflare Worker (control plane and website).
  Nothing in Part B is built yet.
- **Part C** is a short backlog. **Part D** lists what only the owner can answer.

Last updated 2026-11-15. Repo layout and rules: `CLAUDE.md`. User docs: `README.md`, `web/README.md`.

---

## Part A: Handoff note for the Claude Code that has Chrome

> **Banner (2026-11-15): probably skip this part.** Drive is being replaced (Part B), so publishing the
> Google app only matters as a stopgap. The login done on 2026-11-13 stops working around
> **2026-11-20** (Testing status). The cheap stopgap is one command on the Mac, run around 11-19/11-20
> and again a week later if the migration is not finished by then: `rclone config reconnect gdrive:`
> (click through the browser login). Use this part only if the owner wants Drive to keep working
> long-term anyway.

### Goal

Make the Google OAuth consent screen of the mac-watch project show **Publishing status: In
production** (not "Testing"), then confirm the Mac's rclone login survives past 7 days.

### Why it matters

mac-watch uploads to Google Drive through rclone with its **own** Google OAuth client (the shared
rclone client was rate-limited). A Google OAuth app in **Testing** status makes refresh tokens
expire after about **7 days**. The login was done on **2026-11-13**, so uploads and phone commands
will silently stop around **2026-11-20** unless the app is in production. (The Mac's
`./bin/status.sh` would then show an `AUTH PROBLEM` error. `rclone config reconnect gdrive:` buys
another week as a stopgap.)

### What the owner saw (from photos of the screen; nothing here was seen first-hand by Claude)

- Google Auth Platform, **Audience** page: *Publishing status: Testing*, user type *External*. The
  **Publish app** button was **greyed out** with the text *"To publish your app, you must complete
  your configuration on the Branding page."*
- **Branding** page: App name `mac-watch`, a user support email and a developer contact email were
  filled in. **Save** was greyed (nothing unsaved). Logo, home page, privacy policy, terms of
  service and authorised domains were empty.
- Reloading the Audience page did not change anything. The **Verification centre** page has not been
  looked at yet.
- The browser URL contained `authuser=1`: the owner is signed into **several Google accounts** in that
  browser. There may also be **more than one Cloud project**: one console screenshot showed a project
  called "My First Project" with *"You haven't configured any OAuth clients for this project yet"*,
  yet an OAuth client had been created and works. The owner also said they were made to
  "create the OAuth client again" at some point. **Prime suspect: Branding/Audience were edited in a
  different project than the one that owns the working client.**
- The working client is a **Desktop app** client whose ID starts with `644532895687-` (that number is
  the Cloud project *number*; read off a photo, so double-check). A client ID is public, not a secret.

### What to do, in order

1. Ask the owner which Google account owns the Cloud project, and make sure Chrome is using that
   account for the console (use the account switcher; avoid `authuser` guessing).
2. **Find the right project:** in the console project picker, open each project, and match the one whose
   *project number* is `644532895687` (Dashboard or Settings shows it). Check that its **Clients** page
   lists the Desktop client. Do the next steps *in that project*.
3. Open `Google Auth Platform > Verification centre` and read what it says is missing. Fix those items.
4. Open **Branding**. Required fields are only app name, user support email, developer contact. If
   Google insists on more (some projects ask for an authorised domain or links once a *sensitive or
   restricted* scope is declared), supply the minimum: a home page and privacy link can be the
   repo's GitHub README page. Do not invent a domain the owner does not own.
5. Open **Data access**. The rclone remote uses scope `https://www.googleapis.com/auth/drive`
   (a *restricted* scope). It is fine to leave it undeclared for a personal app, or to add it if the
   console requires it for publishing. **Do not** add other scopes.
6. Back on **Audience**, reload, and click **Publish app**. **Ask the owner for a go-ahead in chat
   first** (it is reversible via "Back to testing", but it changes what Google shows on their login).
   Confirm the dialog. The status should read **In production**.
   - Expected and fine: Google keeps showing "Google hasn't verified this app". That only goes away
     with a full verification, which a one-person app does not need. The 100-user cap is irrelevant.
7. **Verify on the Mac** (the owner runs these; do not run anything with `sudo`):
   - `rclone config reconnect gdrive:` and click through the login (Advanced, then continue, then allow Drive).
   - `./bin/status.sh` shows no `ERROR upload`.
   - Put a reminder to re-check `./bin/status.sh` on **2026-11-22** (more than 7 days after the login).
     If it says `AUTH PROBLEM` then, publishing did not take effect; see "If publishing cannot be done".

### If publishing cannot be done

Pick one with the owner and note it in the handoff log:
1. Stay in Testing and run `rclone config reconnect gdrive:` **weekly** (set a recurring reminder).
2. Finish the Backblaze B2 + Cloudflare Worker plan in **Part B**, which removes Google Drive and this problem entirely.

### Hard rules for the other Claude

- **Never print, paste, log or commit** the client *secret*, any token, or `rclone.conf`. If the console
  shows a secret, do not copy it into chat or a file.
- **Do not delete or regenerate the existing Desktop client** unless the owner agrees: that breaks the
  Mac's login. If a new client has to be made, the owner re-runs `./bin/setup-oauth.sh` on the Mac to
  store it.
- Ask the owner to do any password, 2-step verification or CAPTCHA step. Do not try to work around them.
- Do not change anything outside the Google console for this task. The Mac, Drive and the repo are
  out of scope here.
- Keep it to the minimum: no new scopes, no extra test users, no billing or free-trial sign-up
  (the "$300 credit" banner is a trap for this purpose; ignore it).

### Handoff log (the other Claude appends here)

```
date / who:
what was found:
what was changed:
current publishing status:
anything the owner still has to do:
```

---

## Part B: Replace Google Drive with Backblaze B2 + a free Cloudflare Worker

### What "mild remote monitor" means (and does not)

**Yes:** see whether the Mac is alive (lid, battery, power, Wi-Fi, queue, last shot, errors); take a
screenshot **on demand** and get it back in seconds; a **live-ish view** (a fresh low-resolution frame
every few seconds while the page is open); start/stop recordings; pause/resume; change settings;
browse history by day; **Keep** things for archiving; later, an alert when the Mac goes quiet.

**No (on purpose):** remote keyboard/mouse control (that is remote desktop, a very different security
problem), waking a sleeping Mac (impossible over the internet without extra hardware), or anything
while the Mac is asleep, offline or has the lid closed. `KEEP_AWAKE=1` plus the charger is the answer to
"I want it reachable".

### Where it is "fronted": Cloudflare Workers, free plan

A **Worker** is a small program Cloudflare runs for you. Its free plan has no card, gives a
`something.workers.dev` address (no domain needed) and about 100k requests a day. One Worker serves:

1. the **website** (static page),
2. the **API** the website uses (login, list, commands),
3. the **API the Mac uses** (poll for commands, report status).

State lives in **D1** (Cloudflare's free SQLite): commands, status, settings, the index of shots.
**Image and video bytes live in Backblaze B2** (free 10 GB; Backblaze's own pages say no card is needed
to sign up). The Worker reads B2 and streams images to the page; the browser never holds a storage key.

```
 Mac ──rclone──────────────► Backblaze B2 (private bucket)    shots/ recordings/ keep/ live/
 Mac ◄──poll / status──────► Worker + D1  ◄── cookie ── Phone/Laptop browser
                              └─ streams images from B2 for the page
```

Why not the other places (so nobody re-litigates it):

| Option | Verdict |
|---|---|
| Cloudflare R2 | needs a card. Out. |
| Cloudflare Access (login wall) | free plan exists, but I could not confirm it needs no card; not needed, the Worker does its own login |
| Netlify | static only on the free plan (password protection is paid); functions cost credits per call, polling would burn them. Page moves to the Worker |
| Google Drive | slow, 7-day token expiry, whole-Drive permission, rate limits. Being removed |
| **Tailscale + a tiny server on the Mac** | genuinely good for **true real-time** view (no cloud, no polling) but history lives only on the Mac, so it is **useless when the Mac is asleep/offline**, which is exactly when you want to know why. Possible later as an add-on (Part C) |

### How the control feels fast (adaptive polling)

Worker free plan cannot hold a connection open for push, so the Mac **polls** a tiny endpoint:

- **Idle:** every **20 s**. A command typed into the page reaches the Mac in at most about 20 s.
- **While you have the page open:** the page pings the Worker, which flags "watching" for 10 minutes. The
  Mac's reply to its next poll says `fast`, and it then polls every **2 s**. "Screenshot now" then
  arrives in a few seconds: command seen (~1-2 s), shot taken, uploaded, shown (~3-6 s total).
- **Live view:** in fast mode, `live` asks the Mac for a small frame (about 640 px wide, low quality, tens
  of KB) every 3-5 s, uploaded straight to B2 under `live/` (lifecycle rule deletes them after a day) and
  announced to the Worker. It stops 10 minutes after the page was last open. Cost: battery and a few MB
  per minute of viewing; it is off unless you open the page and press **Live**.

Request budget (free plan 100k/day): 20 s idle polling = 4,320/day; one 10-minute fast session = 300;
plus page calls. Well inside, with room for the page being open a lot. D1 reads/writes per poll are 1-2
small rows. **Verify the current D1 daily limits at signup** (I could not find an official number for rows
written per day; KV allows only 1,000 writes/day, which is why KV is not used for this).

### The protocol (line-based so the Mac's `sh` can parse it safely)

Mac to Worker, all `Authorization: Bearer <mac-token>`:

- `GET  /mac/poll?v=<version>&st=<paused|ok>` returns plain text lines, nothing else:
  `fast 1|0`, `cmd <id> snap|record|pause|resume|live-on|live-off <unix-time>`,
  `set KEY=number` (full current set; absent means "use config.env"). The Mac validates every line
  with strict patterns (as `apply_remote_config` does today) and ignores anything else.
- `POST /mac/ack`: `<id>` done (idempotent; commands expire after `MARKER_MAX_AGE_MIN`).
- `POST /mac/status`: the `status.json` we already produce (sizes are small), every 5 min and on change.
- `POST /mac/index`: after a successful rclone upload, the new keys + sizes, so the website lists from
  D1 and **never lists B2** (B2's free tier counts list calls).
- `POST /mac/live`: `{key}` of the newest live frame.

Website to Worker (cookie session): `GET /api/status`, `GET /api/days`, `GET /api/day/<date>`,
`GET /img/<key>` (streams from B2, `Cache-Control` long for immutable shots), `POST /api/command`,
`GET|PUT /api/settings`, `POST /api/keep` (server-side copy to `keep/`), `POST /api/watching`.
Everything is **whitelist-only**: key names are checked against `^(shots|recordings|keep|live)/...`,
no `..`, commands from a fixed list, settings through the same range table as the Mac.

### Security model

- **Login to the website (owner decides, Part D):** (a) **passphrase** the Worker checks against a stored
  hash, with lockout after failed tries, signed `HttpOnly; Secure; SameSite=Strict` cookie, or (b)
  **Sign in with Google** (identity only, scope `email`; no Drive scope, so none of the Publish/verification
  pain; Worker verifies the ID token and an e-mail allow-list). Recommendation: **start with (a)**, it works
  on day one with nothing from Google; add (b) later if wanted.
- **Mac token:** random 256-bit, stored in a `chmod 600` file in the repo folder (git-ignored), only a hash
  stored at the Worker. It can poll, ack, report. It **cannot read images or list anything**.
- **B2 keys:** the Mac gets an application key limited to **one bucket** and no read permission (list +
  write only, enough for `rclone move`); the Worker gets a separate **read** key. Nothing has "whole
  account" rights. (Verify the exact capability names when creating keys in the Backblaze console.)
- **Hard spending cap:** with no card on file Backblaze and Cloudflare cannot bill you. If a card is ever
  added, set B2's daily caps and keep the lifecycle rules.
- The Worker is public code in front of private data: kept small; tests cover path traversal, key
  whitelists, expired commands, bad cookies, login lockout, and that no endpoint can return a B2 key.
- Privacy defaults unchanged: local `PAUSE` file stops everything including talking to the Worker;
  remote pause stops capture/upload but keeps polling so `resume` works.

### Mac-side changes (what code moves)

| Today | After |
|---|---|
| `upload.sh` lists Drive `control/` every minute | new `bin/listen.sh`, a **fifth LaunchAgent** with `KeepAlive`, polls the Worker (20 s / 2 s) and runs commands |
| markers (`snap-now` folders etc.) | commands from `/mac/poll`; the old marker code is deleted |
| `config.remote` file in Drive | `set` lines in the poll reply, same strict parser and ranges |
| `status.json` copied to Drive | `POST /mac/status` |
| `rclone move` to `gdrive:` | `rclone move` to a **b2** remote (native B2 backend), same batching, same `--min-age 15s` |
| prune with `rclone delete` | B2 **lifecycle rule** (delete after 14 days, not for `keep/`); Worker cron trims the D1 index |
| backoff for Drive rate limits | kept as a generic backoff; the rate-limit hint text is removed |
| `setup-drive.sh`, `setup-oauth.sh` | `setup-remote.sh`: asks for the Worker URL, writes the Mac token, runs `rclone config create` for B2 (never prints keys, `chmod 600`) |
| `archive-pull.sh` (Drive remote) | same script, B2 remote with a read-only key |

`capture.sh`, `record.sh`, `trigger.sh`, `lib.sh` (gate, locks, debounce), Hammerspoon and the
install/uninstall tooling are unchanged except for `install.sh` adding the fifth agent.

### How it is tested without Cloudflare or Backblaze (this sandbox cannot reach either)

- Worker logic is written as plain functions over a small storage interface (`worker/core.js`); `wrangler`
  glue is a thin file. Node tests run the same code against an in-memory store.
- A node HTTP server wraps `core.js` on localhost; the shell tests run the **real Mac scripts and real
  curl** against it (poll, commands, expiry, fast mode, status, index, pause, settings, token rejection).
- B2 side: rclone's `local` backend, as the Drive tests do now.
- Not testable here: real Cloudflare, real Backblaze, the real login cookie in a real browser. Those need
  a first-deploy check by the owner (a short checklist goes into `worker/README.md`).

### Steps

- **B0 (owner, ~15 min):** create a Cloudflare account and a Backblaze account **without adding a card**.
  Confirm: Workers + D1 enable without a card; B2 bucket creation works without one. Tell me the result.
  If either insists on a card, stop and use the **Tailscale** option in the table (or revisit).
- **B1: Worker core + tests** (`worker/`): login, poll/ack/status/index, commands + expiry, settings
  validation, image proxy, keep, watching/fast flag, cron cleanup. `wrangler.toml`, deploy README.
- **B2: Mac side** (`listen.sh`, `api.sh`, `setup-remote.sh`, upload to B2, status/index calls, install.sh
  fifth agent, `selftest.sh` checks for the new path) with the fake-Worker shell tests.
- **B3: Website** rewrite (`web/api.js` replaces `web/drive.js`; `logic.js` keeps the settings table, health
  and file-name parsing; the same wiring tests apply): status card, **Screenshot now**, **Live** view,
  gallery, recordings, settings, Keep.
- **B4: Cut over** (owner on the Mac): deploy Worker, run `setup-remote.sh`, `./bin/install.sh`, copy history
  once with `rclone copy gdrive:mac-watch b2:<bucket>` if wanted, watch `./bin/status.sh` for a day.
- **B5: Remove Drive:** revoke the rclone token in the Google account permissions page, delete the OAuth
  clients, delete the Netlify site, delete `web/drive.js`, `setup-oauth.sh`, `setup-drive.sh`, the Drive
  marker/prune code, update `README.md` and `CLAUDE.md`.

### Risks and honest limits

- **Most new code of any step so far**, all of it unverifiable against the real services from here. Expect a
  first-deploy debugging round; budget for it.
- **Cloudflare/Backblaze free terms can change**; sign-up behaviour (card or not) is the first thing to check.
- A sleeping/offline Mac is a hole in any design: the page can only say "last seen 40 min ago".
- Live view and polling use some battery on an unplugged Mac; both are throttled and live view is opt-in.
- Single-owner design: no multi-user accounts, no password reset flow (reset = redeploy the Worker secret).

## Part C: Backlog (not scheduled)

- **"Mac went quiet" alert.** A Worker **cron trigger** (free plan allows a few) checks the status age and
  sends a free push (for example ntfy.sh) when a Mac that reported "awake, lid open, not paused" goes silent
  for 20 minutes. Falls out cheaply once Part B exists.
- **True real-time view over Tailscale** as an optional add-on, for when you are watching live and the Mac is
  awake (no cloud hop, no polling delay).
- **`bin/update.sh`** on the Mac: `git pull`, re-run `install.sh`, restart agents.
- **Frontmost app name** in the status line (via `osascript`); needs an extra macOS permission; opt-in.
- **Daily timelapse / contact sheet** per day with `ffmpeg` (optional dependency).
- **Idle-time trigger** (`HIDIdleTime`) if Hammerspoon proves flaky.
- **Download a day as a zip** from the website.

---

## Part D: Questions for the owner

1. B0: do Cloudflare (Workers + D1) and Backblaze (B2 bucket) both sign up and work **without a card**?
2. Website login: **passphrase first** (recommended) or Google sign-in from the start?
3. OK that **live view** is opt-in (button) and costs some battery?
4. `KEEP_AWAKE=1` + charger when you leave it at home? (Decided separately; matters for "reachable".)
5. History: copy the existing Drive shots into B2, or start fresh?
6. Name for the site: `butter-bot.<account>.workers.dev` is what you will get; a custom domain is optional.
