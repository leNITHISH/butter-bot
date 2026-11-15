# PLAN.md: replace Google Drive with Backblaze B2 + a Cloudflare Worker

**Audience:** the owner, and the Claude Code instance that will build and deploy this (it runs on the
owner's Arch machine with a browser and real network access to Cloudflare and Backblaze, which the
original sandbox did not have). Read `CLAUDE.md` first (rules, layout), then `README.md`.

Last updated 2026-11-15. **W0 to W4 done and deployed; W5 (Mac cut-over) and the owner part of W6 remain.** See the handoff log at the end.

---

## 0. Decisions already made by the owner

| Topic | Decision |
|---|---|
| Storage | **Google Drive is removed completely.** Too slow to sync, poor for remote control. |
| Cloudflare R2 | **No** (needs a payment card; the owner has none). |
| Money | **Free only, no card anywhere.** Cloudflare account and Backblaze account are already created. |
| Login to the website | **Sign in with Google** (identity only). A passphrase is *not* wanted. |
| History | **Start fresh.** Nothing is copied from Drive. |
| Google "Publish app" | **Not needed any more** (no Drive scope). Ignore every earlier note about it. |
| Goal | A **mild remote monitor**: status, on-demand screenshot, live-ish view, recordings, pause, settings, a **file explorer** to download single screenshots on a phone, **purge** of old shots, and a **live storage monitor**. |
| Branch | Work on `main` (owner's instruction). |

Not in scope, on purpose: remote keyboard/mouse control, waking a sleeping Mac, anything while the Mac is
asleep/offline/lid closed.

---

## 1. Who does what

- **Builder instance (Arch, network, browser):** writes the Worker, the new Mac scripts and the website
  following this plan, deploys with `wrangler`, and **verifies against the real services** (the first
  time any of this touches them). Appends to the handoff log (section 12).
- **Owner:** logins and anything needing a password or 2-step (Cloudflare, Backblaze, Google), pasting
  secrets *into the terminal prompts* of the setup scripts, and running things **on the Mac**
  (`git pull`, `./bin/install.sh`, `./bin/selftest.sh`). The Builder cannot test macOS behaviour.
- **Hard rules:** never print, log, paste in chat or commit an application key, the Mac token, the
  session secret or `rclone.conf`. Never use `sudo`. Do not touch anything outside the repo on the Mac
  except `~/Library/LaunchAgents` (see `CLAUDE.md`). Ask before anything destructive on the owner's
  accounts.

---

## 2. Owner setup guide (what the owner does, in order, about 30 minutes)

UI wording drifts; the goal of each step matters more than the exact button names.

### 2.1 Backblaze B2 (bucket, lifecycle, two keys)

1. Backblaze web UI, **Buckets, Create a Bucket**: a globally unique name such as `macwatch-<6 random
   letters>`, **Private**, encryption on (default), Object Lock **off**. Write the bucket name down.
2. **Lifecycle settings** on that bucket, custom rules, as a *backstop* only (the Worker enforces the
   real retention from the owner's setting): for file-name prefixes `shots/`, `thumbs/`, `recordings/`
   set "days from uploading to hiding" = **30** and "days from hiding to deleting" = **1**; for `live/`
   set **1** and **1**. **No rule for `keep/`.**
3. **Application Keys, Add a New Application Key**, restricted to **that bucket only**, twice:
   - `macwatch-mac`: for the Mac. Read-and-write is the simplest in the UI. Better, if the Builder uses
     the `b2` CLI: capabilities `listBuckets,listFiles,writeFiles,deleteFiles` (no `readFiles`), then check
     `rclone move` still works (section 11).
   - `macwatch-worker`: for the Worker. Read-and-write (it reads, copies for **Keep**, and deletes for
     **purge**).
   Each key's secret is shown **once**. Put them straight into the setup prompts (below) or a password
   manager. **Never into chat.**

### 2.2 Cloudflare (Worker + D1)

1. Choose the account's `workers.dev` subdomain if not set yet (Workers & Pages, first-time onboarding).
2. On the Arch machine: `npm install -g wrangler` (or use `npx wrangler`), then `wrangler login`
   (browser consent).
3. The Builder then runs: `wrangler d1 create macwatch` (copy the printed `database_id` into
   `worker/wrangler.toml`), `wrangler d1 execute macwatch --remote --file worker/schema.sql`,
   `wrangler secret put ...` for each secret in section 6.4, and `wrangler deploy`.
   The URL is `https://butter-bot.<subdomain>.workers.dev` (worker name `butter-bot`).
4. **Confirm no card prompt appeared** for Workers, D1 or cron triggers. If any step demands a card, stop
   and tell the owner (see section 11).

### 2.3 Google sign-in client (identity only, no Drive)

1. Google Cloud console, the project the owner already has: **APIs & Services, Credentials, Create
   credentials, OAuth client ID, Web application**.
2. **Authorised JavaScript origins:** `https://butter-bot.<subdomain>.workers.dev` and
   `http://localhost:8787` (for `wrangler dev`). No redirect URI is needed (Google Identity Services).
3. Copy the **Client ID** (public). Ignore the secret; it is not used.
4. **OAuth consent screen:** user type External, add **the owner's own Google account as a Test user**.
   Add **no** extra scopes (the defaults `openid email profile` are enough). Publishing is not required
   for sign-in; the Drive scope is gone, so the 7-day Testing expiry no longer matters.
5. The Worker is told the client ID (`GOOGLE_CLIENT_ID`, a plain variable) and the **one allowed e-mail**
   (`ALLOWED_EMAIL`, a secret so it is not in the repo).

### 2.4 On the Mac (after the Builder says it is deployed)

```sh
git pull
./bin/setup-remote.sh      # asks for the Worker URL and the Mac's B2 key; creates the Mac token
./bin/install.sh           # adds the "listen" agent; removes the Drive agents' marker polling
./bin/selftest.sh
```

`setup-remote.sh` prints the **SHA-256 of the new Mac token** (never the token itself) for the Builder to
store with `wrangler secret put MAC_TOKEN_HASH`.

---

## 3. Architecture

```
 Mac ──rclone (b2)──────────────► Backblaze B2 (private bucket)
 Mac ◄──poll 20 s / 2 s────────► Worker (butter-bot) + D1 ◄──cookie── Phone / laptop browser
                                  ├─ serves the website (static assets)
                                  └─ streams images/videos from B2 to the page (no B2 key in the browser)
```

- **Bytes** (shots, thumbnails, recordings, live frames) live in **B2**. **Everything small** (commands,
  status, settings, the file index, counters) lives in **D1**.
- The Mac never polls B2 and the website never lists B2: B2's free daily transaction allowance is small
  (about 2,500 each of downloads and list-type calls per day; confirm live), so the file index is kept in
  D1 and only reconciled by a daily cron job.
- The Mac and the Worker never connect to each other except through the Mac's outbound HTTPS polling.

### Rejected options (do not revisit without a reason)

R2 (needs card), Drive (slow, scopes), Netlify (static only on free; functions burn credits when polled),
Cloudflare Access (could not confirm no-card; the Worker does its own login), Tailscale-only (nothing
works when the Mac is asleep; may come later as an add-on for true real-time view).

---

## 4. Latency: adaptive polling

- The Mac polls `GET /mac/poll` every **20 s** normally.
- When the owner's page is open it pings `POST /api/watching` every 30 s; the Worker keeps
  `watching_until = now + 600 s`. While that is in the future the poll reply contains `fast 1` and the Mac
  polls every **2 s**. "Screenshot now" then shows up in about 3 to 6 s.
- **Live view** (button on the page) sets `live_until = now + 600 s`; the reply contains `live 1` and the
  Mac captures a small frame (640 px wide, JPEG quality about 40, tens of KB) every **4 s**, uploads it with
  rclone to `live/<timestamp>.jpg` and calls `POST /mac/live`. Off by default. Stops 10 minutes after the
  page was last open or on `live-off`.
- Budget on the free plan (100k Worker requests/day): idle polling 4,320/day, one fast session about 300,
  page traffic extra. D1 writes per poll are at most 1 (`last_seen` is updated at most once a minute).

---

## 5. Wire protocol

All responses `Cache-Control: no-store`. Errors are JSON `{"error":"..."}` for the website, a bare status
code for the Mac. **Never** put a B2 key, token or secret in any response.

### 5.1 Mac to Worker (`Authorization: Bearer <mac-token>`; the Worker compares SHA-256 hashes in constant time)

`GET /mac/poll?paused=no|local|remote` returns **plain text, one item per line**, nothing else:

```
fast 1
live 0
cmd 41 snap 1763200000
cmd 42 record 1763200010
set INTERVAL_SEC=120
set JPEG_QUALITY=50
```

- `cmd <id> <name> <unix-time>`: `name` is one of `snap record pause resume`. The Mac **ignores** commands
  older than `MARKER_MAX_AGE_MIN` (except `pause` / `resume`, which stay valid, as today), executes each
  `id` at most once (remember the last handled id in `state/last-cmd`), then calls `/mac/ack`.
- `set KEY=number`: the **full** current settings set. The Mac validates every line with the existing
  strict parser and range table (`remote_bounds` in `bin/lib.sh`); anything else is dropped. An absent
  `set` block means "no overrides": delete `state/remote.conf`.
- Unknown lines are ignored (forward compatibility).

`POST /mac/ack` body `<id>` (idempotent). `POST /mac/status` body is `state/status.json` (extend it with
`diskFreeGB`, `queueMB`, `localShots`). `POST /mac/index` body is lines `<key> <bytes> <reason>` for files
that were **verifiably uploaded** (taken from the queue listing before `rclone move`, minus what is still
queued after). `POST /mac/live` body `<key>`.

### 5.2 Website to Worker (session cookie + header `X-MW: 1`; `SameSite=Strict; HttpOnly; Secure`)

| Endpoint | Purpose |
|---|---|
| `GET /auth/config` | `{clientId}` for the Google button (public) |
| `POST /auth/google` `{credential}` | verify the Google ID token (section 8), set the session cookie |
| `POST /auth/logout` | clear the cookie; bump `session_epoch` to invalidate all sessions |
| `GET /api/status` | latest status.json, `lastSeen`, `watching`, `live`, paused state |
| `GET /api/storage` | the storage monitor payload (section 7.3) |
| `GET /api/days?kind=shots|recordings|keep` | days with file count and bytes, newest first |
| `GET /api/files?day=YYYY-MM-DD&kind=...&after=<cursor>&limit=60` | file page (name, bytes, reason, time) |
| `GET /img/<key>` | inline stream of one object (thumbnails, previews, video with `Range`) |
| `GET /dl/<key>` | same object as an **attachment** with a clean file name (phone download) |
| `POST /api/command` `{name}` | `snap record pause resume live-on live-off` |
| `GET|PUT /api/settings` | the numbers in section 7.4, validated server-side with the same ranges |
| `POST /api/keep` `{keys[]}` | server-side copy to `keep/<day>/<name>`, then delete the original |
| `POST /api/purge` | section 7.2 |
| `GET /api/live` | `{key, taken}` of the newest live frame, if any |
| `POST /api/watching` | extend fast mode |

**Key whitelist everywhere a key is accepted:** `^(shots|thumbs|recordings|keep)/\d{4}-\d{2}-\d{2}/[A-Za-z0-9._-]+\.(jpg|mov)$`
or `^live/[A-Za-z0-9._-]+\.jpg$`. No `..`, no leading `/`, no percent-decoding games (decode once, then
match).

---

## 6. Data

### 6.1 D1 schema (`worker/schema.sql`)

```sql
CREATE TABLE files (
  key      TEXT PRIMARY KEY,           -- e.g. shots/2026-11-15/20261115-120301-space.jpg
  kind     TEXT NOT NULL,              -- shots | thumbs | recordings | keep | live
  day      TEXT NOT NULL,              -- YYYY-MM-DD ('' for live)
  name     TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  reason   TEXT NOT NULL DEFAULT '',
  uploaded INTEGER NOT NULL            -- unix time the Worker learned about it
);
CREATE INDEX files_by_day ON files(kind, day, name);
CREATE TABLE commands (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  created INTEGER NOT NULL,
  acked   INTEGER
);
CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER NOT NULL);
  -- status_json, settings (the 'set' lines), last_seen, watching_until, live_until, live_key,
  -- b2_auth (token, apiUrl, downloadUrl, expiry), session_epoch
CREATE TABLE usage (day TEXT PRIMARY KEY, worker_requests INTEGER NOT NULL DEFAULT 0, b2_downloads INTEGER NOT NULL DEFAULT 0);
```

Request counters are **sampled** (add 10 with probability 1/10) to keep D1 writes low. They are estimates
and are labelled so on the page.

### 6.2 Object layout in B2

```
shots/YYYY-MM-DD/<YYYYMMDD-HHMMSS-reason>.jpg        full screenshot (as now)
thumbs/YYYY-MM-DD/<same name>.jpg                    320 px wide, about 15 KB (gallery uses these)
recordings/YYYY-MM-DD/<...>-rec.mov
keep/YYYY-MM-DD/<name>                               never purged automatically
live/<YYYYMMDD-HHMMSS>.jpg                           live frames, deleted after 1 day
```

`capture.sh` also writes the thumbnail (`sips --resampleWidth 320`) to `queue/thumbs/DATE/` so the gallery
and explorer never download full-size images just to show a grid.

### 6.3 Mac files

- `config.env`: remove `RCLONE_REMOTE=gdrive`/`DRIVE_FOLDER`; add `WORKER_URL=` (public), `RCLONE_REMOTE=b2`,
  `B2_BUCKET=`. `.mac-token` (chmod 600, git-ignored) holds the Mac token.
- Remote settings whitelist (`remote_bounds` in `bin/lib.sh`, mirrored in `web/logic.js`, **tests check they
  match**): keep today's 12 and add the Worker-side ones only on the Worker (`RETENTION_DAYS`,
  `STORAGE_SOFT_LIMIT_GB`; the Mac ignores them).

### 6.4 Worker secrets and variables

Secrets (`wrangler secret put`): `SESSION_SECRET` (32 random bytes), `MAC_TOKEN_HASH` (SHA-256 hex),
`ALLOWED_EMAIL`, `B2_KEY_ID`, `B2_APP_KEY` (the **worker** key), `B2_BUCKET`.
Plain vars in `wrangler.toml`: `GOOGLE_CLIENT_ID`.

---

## 7. Features

### 7.1 File explorer (phone-first)

- Roots: **Screenshots**, **Recordings**, **Keep**. A root lists **days** (count, size), newest first; a day
  lists **files** newest first with a thumbnail, time, reason (`space`, `interval`, `remote`, ...) and size.
  Paginated with a cursor, 60 per page, lazy-loaded thumbnails.
- Tap a file: viewer with the full image (or the video, with seeking via `Range`), **Download**
  (`/dl/<key>`, a normal link so phones save it), **Keep**, **Delete**.
- Select mode (long-press): Download (one at a time through the browser; no server-side zip), Keep, Delete.
- Always works without JavaScript heroics: links for downloads, plain `<img src="/img/...">` for thumbnails.

### 7.2 Purge

- `POST /api/purge` `{mode:"keys"|"day"|"olderThanDays", keys?, day?, days?, kinds?, dryRun}`.
- Always run **`dryRun:true` first** (the page does): the reply says how many files and how many MB would be
  deleted. The page asks the owner to confirm showing those numbers. `keep/` is **never** touched unless the
  request names keep keys explicitly. `live/` is not part of purge (expires on its own).
- Deletion = find the B2 version (`b2_list_file_names` for the exact key to get its `fileId`), then
  `b2_delete_file_version`, then delete the D1 row. Run in small batches (the free plan has limited CPU and
  subrequests per invocation); the endpoint returns a cursor so the page can continue.
- A cron job applies the **retention setting** the same way (default 14 days) and a **storage guard**
  (section 7.3).

### 7.3 Live storage monitor

`GET /api/storage` returns, computed from D1 (reconciled daily against a real B2 listing):

- B2 used vs the **10 GB free allowance**, with a bar that turns amber at 70 % and red at 90 %.
- Breakdown by kind (shots, thumbs, recordings, keep, live), file counts.
- Bytes per day for the last 14 days, average growth per day over the last 7, and **days until the soft
  limit** at that rate.
- The Mac: `diskFreeGB`, `queueMB`, `queueFiles` from the latest status.
- Estimated usage today: Worker requests of 100k, B2 downloads of the daily allowance (amber at 80 %).
- The page refreshes this panel every 30 s while visible.

**Storage guard (cron, every 15 min):** if used > `STORAGE_SOFT_LIMIT_GB` (default 8, range 1 to 9), delete
the oldest **non-keep** days until used is 1 GB under the limit. This is how "free only, no card" stays true.
The daily reconcile job lists the whole bucket (about 9 pages of 1000 for a month of shots) and fixes any
drift between D1 and B2.

### 7.4 Settings from the page

The existing numeric whitelist (screenshot interval, spacebar gap, JPEG quality, width, record seconds,
upload batch seconds, keep-awake, marker age, ...) plus the Worker-side `RETENTION_DAYS` (3 to 365) and
`STORAGE_SOFT_LIMIT_GB`. Numbers only, ranges enforced in both places.

### 7.5 Status card

As today plus: how long since the Mac was **seen** (green under 8 min, amber under 20, red above, with the
explanation "asleep, offline, lid closed, or PAUSE file"), watching/live state, and the pause state (a local
`PAUSE` file cannot be lifted from the page).

---

## 8. Login (Sign in with Google, identity only)

1. The page loads `https://accounts.google.com/gsi/client`, shows the Google button with the client ID from
   `/auth/config`.
2. Google returns an **ID token** (a signed JWT). The page POSTs it to `/auth/google`.
3. The Worker verifies it **itself**: fetch and cache Google's public keys
   (`https://www.googleapis.com/oauth2/v3/certs`), check the RS256 signature with WebCrypto, `iss` is
   `https://accounts.google.com` or `accounts.google.com`, `aud` equals `GOOGLE_CLIENT_ID`, `exp` is in the
   future, `email_verified` is true, and `email` equals `ALLOWED_EMAIL` (compare lower-cased, constant
   time). Anything else: 403 with no detail.
4. On success it sets a signed session cookie (HMAC with `SESSION_SECRET`, 14 days, includes
   `session_epoch`), `HttpOnly; Secure; SameSite=Strict; Path=/`.
5. Every `/api/*`, `/img/*`, `/dl/*` request checks the cookie. State-changing requests also need the
   `X-MW: 1` header (blocks cross-site form posts) and a JSON content type.
6. Logout bumps `session_epoch`, which kills every session.

Content-Security-Policy on every response: `default-src 'self'; script-src 'self'
https://accounts.google.com/gsi/client; connect-src 'self' https://accounts.google.com; img-src 'self'
blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style;
frame-src https://accounts.google.com/gsi/; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
Plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`.

---

## 9. Mac-side change list

| Today | Change |
|---|---|
| `upload.sh` polls Drive `control/`, parses markers | **delete** marker/config/Drive code; keep queue cap, online check, locks, flush, backoff |
| (none) | **`bin/listen.sh`**: persistent loop (new LaunchAgent `com.macwatch.listen`, `KeepAlive`, `RunAtLoad`): poll, run commands, apply `set` lines, ack, adaptive sleep, live frames. Honours `gate()` and `PAUSE` exactly as `trigger.sh` does |
| (none) | **`bin/api.sh`**: `curl` wrappers (timeouts, retries, token from `.mac-token`, never echoes it) |
| `rclone move` to `gdrive:` | `rclone move` to `b2:$B2_BUCKET/...` with `--min-age 15s`; kinds `shots thumbs recordings`; then `POST /mac/index` |
| `rclone delete` prune | **removed**; retention is the Worker's job |
| `report.sh` writes status.json, `upload.sh` copies to Drive | `report.sh` adds disk/queue fields; `listen.sh` POSTs it every 5 min and on change |
| `capture.sh` | also writes the 320 px thumbnail into `queue/thumbs/DATE/` |
| `setup-drive.sh`, `setup-oauth.sh` | replaced by **`bin/setup-remote.sh`** (prompts for Worker URL and the Mac's B2 key id/secret with hidden input, creates the token, writes the rclone `b2` remote, `chmod 600`, prints the token hash only) |
| `archive-pull.sh` | works with the `b2` remote (read-capable key needed on the archive laptop: the owner makes a third key for it) |
| `install.sh`, `uninstall.sh`, `status.sh`, `diagnose.sh`, `selftest.sh` | add the listen agent; status shows Worker reachability, last poll, command backlog; selftest checks a real round trip |
| `web/` (Drive client) | rewritten, section 10; `netlify.toml` and the Netlify site are deleted |

Unchanged: `lib.sh` gate/locks/debounce/`remote_bounds`, `trigger.sh`, `record.sh`, `heartbeat.sh`,
Hammerspoon files and the Hammerspoon login agent, the local `PAUSE` semantics.

Remote **pause/resume** keep their meaning: remote pause stops capture/record/upload but `listen.sh` keeps
polling so **resume** works; the local `PAUSE` file stops **everything** including polling.

---

## 10. Website

Static files served by the Worker (Workers Static Assets). Plain HTML/CSS/JS, no framework, phone-first,
dark mode, large tap targets, `textContent` only (never inject HTML from data). Screens:

1. **Sign in** (Google button).
2. **Home:** status card, command buttons (Screenshot now, Record, Pause/Resume, Live), the latest shot,
   storage meters (compact).
3. **Explorer** (section 7.1) with Keep / Download / Delete / Purge.
4. **Storage** (section 7.3) full panel.
5. **Settings** (section 7.4).

`web/logic.js` (settings table, health, name parsing) is reused; `web/drive.js` becomes `web/api.js`.

---

## 11. Things to VERIFY LIVE (not confirmable from the original sandbox)

1. Workers, D1, cron triggers and Static Assets all work on the free plan **with no card**; read the current
   free limits (D1 rows read/written per day were not found in official docs; KV is **not** used because
   it allows only 1,000 writes/day).
2. Backblaze bucket creation and application keys need **no card**; read the actual free storage and the
   daily free transaction allowances (download, list); confirm what happens when the 10 GB is exceeded
   with no card (so the storage guard threshold is safe).
3. The Mac key's reduced capability set (`listBuckets,listFiles,writeFiles,deleteFiles`) is enough for
   `rclone move` to a `b2` remote; if not, use the UI "Read and Write" key restricted to the bucket and
   note it in the log.
4. The Cache API generally does **not** work on `*.workers.dev`; rely on browser caching
   (`Cache-Control: private, max-age=...` on immutable shots/thumbs) and the thumbnails instead.
5. Google sign-in works in "Testing" status with only the owner as a test user (basic scopes).
6. `wrangler dev` plus a real B2 bucket works locally on Arch; use it for the first end-to-end run.

If 1 or 2 fails because of a card requirement, **stop** and tell the owner: the fallback is the
Tailscale-based design (`Part C`, below), or staying on Drive with the weekly reconnect.

---

## 12. Work breakdown (do in order; each ends with `make check` green and a commit on `main`)

- **W0.** Read `CLAUDE.md`, run `make check` once to see the baseline (242 checks). Do section 11 items
  1, 2, 6 with the owner present. Record findings in the log below.
- **W1. Worker core.** `worker/core.js` (pure functions over a small storage/B2 interface), `worker/index.js`
  (thin Cloudflare glue), `worker/schema.sql`, `wrangler.toml`. Auth, poll/ack/status/index/live,
  commands + expiry, settings validation, files/days, `/img`, `/dl`, keep, purge, storage, watching, cron
  jobs. **Node tests** with in-memory fakes (`tests/worker_test.js`): auth (bad/expired/wrong-audience
  tokens, wrong e-mail), cookie tampering, CSRF header, key whitelist and traversal, commands expire,
  settings ranges, poll reply format, purge dry-run vs real, keep copy, storage maths, guard picks the
  oldest non-keep day, no response ever contains a secret.
- **W2. Mac side.** `api.sh`, `listen.sh`, `setup-remote.sh`, `upload.sh` rewrite, `capture.sh` thumbnails,
  `report.sh` fields, `install.sh` (listen agent), `status.sh`, `diagnose.sh`, `selftest.sh`. Tests: a
  **node HTTP server wrapping `worker/core.js`** on localhost; the shell tests run the **real Mac scripts
  and real `curl`** against it (poll, command handling and expiry, ack, fast mode, set lines, rejected
  lines, token rejection, offline behaviour, pause/resume semantics, `PAUSE` stops polling). rclone tests
  keep using the `local` backend as a stand-in for B2.
- **W3. Website.** `web/api.js` and the five screens. Node tests: wiring (every `$(id)` exists), no
  `innerHTML`, CSP present, settings table matches the shell, API client against the fake server.
- **W4. Deploy + live verification** (owner present for logins): `wrangler deploy`, sign in, take a
  screenshot from the phone, download one file, purge a test day, watch the storage panel move.
- **W5. Cut over on the Mac** (owner runs the commands), watch `./bin/status.sh` for a day.
- **W6. Remove Drive:** owner revokes the rclone token at the Google account permissions page and deletes
  the Drive OAuth clients; delete `web/drive.js`, `bin/setup-oauth.sh`, `bin/setup-drive.sh`, the old
  marker/Drive code and its tests, `netlify.toml`; delete the Netlify site; update `README.md`,
  `web/README.md`, `CLAUDE.md`; mark this plan done.

**Definition of done:** `make check` green under dash and bash `--posix`; the Mac's `selftest.sh` passes on
the real Worker; from the owner's phone: status, screenshot-now in under 10 s with the page open, Live,
download a single screenshot, purge with preview, and the storage meter all work.

---

## 13. Security checklist (verify before calling W4 done)

- [ ] No endpoint returns or logs a B2 key, the Mac token, `SESSION_SECRET` or `ALLOWED_EMAIL`.
- [ ] Every `/api`, `/img`, `/dl` route rejects a missing/forged/expired cookie; state-changing routes
      reject a missing `X-MW` header.
- [ ] Key whitelist regex used everywhere a key is accepted; tests for `..`, encoded `..`, leading `/`,
      other buckets, other prefixes.
- [ ] Mac routes accept only the Mac token; the Mac token cannot read images or call `/api`.
- [ ] Settings can only be numbers in ranges; `set` lines on the Mac go through the strict parser.
- [ ] `keep/` survives retention, the storage guard and `purge` by day/age.
- [ ] CSP and the other headers in section 8 present on every response.
- [ ] Login lockout is not needed (Google does auth), but ID-token verification failures are logged without
      the token.
- [ ] Cloudflare and Backblaze accounts have 2-step verification on (owner).

---

## 14. Risks

- This is the **largest untested-against-reality change so far**; budget for a debugging round at W4.
- Free-tier terms can change; the storage guard and the page's meters exist so nothing silently overruns.
- Anything while the Mac sleeps is invisible: the page can only say "last seen X ago". `KEEP_AWAKE=1` plus
  the charger is the owner's call.
- A public Worker fronts private data: keep it small, whitelist-only, covered by the tests above.

---

## Part C. Backlog and alternatives

- **"Mac went quiet" push alert:** cron job checks status age; send a free push (ntfy.sh) when a Mac that
  reported awake/lid-open/not-paused goes silent for 20 minutes.
- **Tailscale add-on:** true real-time view when the Mac is awake (no cloud hop). Also the fallback if
  Cloudflare or Backblaze turn out to need a card.
- **`bin/update.sh`:** `git pull`, re-run `install.sh`, restart agents.
- **Frontmost app name** in status (needs an extra macOS permission; opt-in).
- **Daily timelapse** with `ffmpeg`; **zip download of a day** (client-side).
- **Idle-time trigger** (`HIDIdleTime`) if Hammerspoon proves flaky.

---

## Handoff log (the Builder instance appends here)

### 2026-11-15, Builder (Claude Code on the Arch laptop, Chrome + wrangler)

**Verified live (section 11):**
1. Cloudflare, no card asked anywhere: Workers deploy, D1 create + schema, two cron triggers,
   Static Assets (`run_worker_first`), workers.dev subdomain `butter-bot-worker` (the new TLS
   certificate took a few minutes). wrangler 4.162.0.
2. Backblaze, no card asked: bucket `macwatch-twjdnu` created (private, SSE-B2, Object Lock off),
   lifecycle rules set as in 2.1. The owner made the two keys; `put-secrets.sh` authorized the
   worker key against B2 (restricted to the bucket) before storing it. Not checked yet: what B2
   does above 10 GB with no card (the guard keeps us at 8 GB).
3. Not tested yet: the Mac key with reduced capabilities (the owner made "Read and Write" keys,
   the simple option in 2.1).
4. Not relied on: the Cache API. Images are sent `Cache-Control: private, max-age=31536000, immutable`.
5. Google sign-in works for real: new *Web application* client, the owner signed in on the
   deployed page and the Worker's own RS256 verification accepted the token.
6. `wrangler dev` not used: the shell tests run `worker/core.js` in node (node:sqlite as D1, a
   folder as B2) and the Mac scripts talk to it with real curl. That covered more than a dev
   server would without B2 keys on this laptop.

**Built:** everything in W1 to W3 as specified, plus the parts of W6 that are code: Drive and
Netlify code and docs removed (`setup-drive.sh`, `setup-oauth.sh`, `web/drive.js`,
`web/config.js`, `netlify.toml`, the marker/prune/config.remote code and their tests). README,
`web/README.md`, CLAUDE.md updated. `make check` green under dash and bash --posix (272 shell
checks per shell, 175 Worker checks, 74 web checks; real-rclone section included).

**Deviations, and why:**
- `GOOGLE_CLIENT_ID` is a Worker **secret** set by `put-secrets.sh`, not a `[vars]` entry, so
  setting it needs no file edit and redeploy. It is public either way.
- Upload: one `rclone move` for all kinds with `--include` filters and `--no-check-dest` (every
  rclone start costs a B2 authorize, a class C call; `--no-check-dest` skips a listing).
  `--now` (after Screenshot now, after a recording) uses min-age 0. Files only enter `queue/`
  by atomic `mv`, so they are always complete; batches keep the 15 s margin.
- Live frames are not deleted by the Worker (deleting would need a class C listing per batch).
  The B2 lifecycle rule `live/` 1+1 days does it; the Worker drops their D1 rows after 2 days.
- Remote shot debounce lowered from 20 s to 5 s (two taps 10 s apart are two shots; the
  Worker merges taps within 10 s).
- `record.sh` no longer writes `done-*.txt` notes (no Drive `control/`). The recording appears in
  Files > Recordings, and it uploads at once (`MW_NO_UPLOAD=1` keeps it local for selftest).
- `archive-pull.sh --free-drive` is now `--free-remote` (the old flag still works). It uses
  `--b2-hard-delete`; the page's list catches up at the daily reconcile.
- Purge by key also deletes the shot's thumbnail. Keep moves only the full shot (the Keep
  grid shows the full image).
- `formatBytes` uses decimal units, like Backblaze (10 GB = 10e9 bytes).

**Owner still has to do:**
- W5, on the Mac: `git pull`; `./bin/setup-remote.sh` (paste the `macwatch-mac` key; it prints a
  hash); on the laptop `./worker/put-secrets.sh MAC_TOKEN_HASH` and paste the hash; on the Mac
  `./bin/setup-remote.sh` again (should say OK), `./bin/install.sh`, `./bin/selftest.sh`, then
  paste the output back. Watch `./bin/status.sh` for a day.
- W6, accounts: revoke the old rclone Drive token (myaccount.google.com/permissions); delete the
  old Drive OAuth *Desktop* client in Google Cloud (keep the new Web client); delete the Netlify
  site. On the Mac `rclone config delete gdrive` (optional).
- Turn on 2-step verification for Cloudflare and Backblaze if it is not on (section 13).
- Optional: `npx wrangler tail` while testing from the phone shows Worker errors live.
