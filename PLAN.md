# PLAN.md

Two things live here:

- **Part A** is a handoff note for a *different* Claude Code (the one on the owner's Arch machine
  that can drive their Chrome) to get the Google OAuth app **published** ("In production").
- **Part B** is the plan for moving off Google Drive to **Cloudflare R2 + a Worker website**, with
  the honest trade-offs. Nothing in Part B has been built. It is a plan, awaiting a decision.
- **Part C** is a short backlog of other features. **Part D** is the questions only the owner can
  answer.

Last updated 2026-11-15. Repo layout and rules are in `CLAUDE.md`; user docs in `README.md` and
`web/README.md`.

---

## Part A: Handoff note for the Claude Code that has Chrome

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
2. Move to the Cloudflare R2 plan in **Part B**, which removes Google Drive and this problem entirely.

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

## Part B: Move from Google Drive to Cloudflare R2 + a Worker website

### Short answer

**Technically yes, it fixes more problems than it costs. But do not start before three things are
confirmed** (below), and do not drop Drive until the current setup has been shown to work once.
Everything that hurt so far came from Google: the shared-client rate limit, the 7-day Testing
expiry, the greyed-out Publish button, and the *full-Drive* permission needed to see phone markers.
R2 has none of those.

### What would change

```
          today                                  after
  Mac --rclone--> Google Drive          Mac --rclone (S3)--> R2 bucket (private)
  Phone/Web --Drive API--> Drive        Phone/Web --> Cloudflare Worker --> R2 bucket
  (browser holds a full-Drive token)    (browser holds no storage credential at all)
  Netlify serves the page               Cloudflare serves the page (Worker static assets or Pages)
  Google login = who may open it        Cloudflare Access (Google or e-mail code) = who may open it
```

- **Mac side** keeps all its logic: rclone speaks S3 as easily as Drive. The `gdrive` remote becomes an
  S3 remote with provider `Cloudflare`, and the folder name becomes the bucket. The Mac's key is an R2
  API token scoped to **one bucket**, instead of *your whole Google Drive*.
- **Website** becomes a **Worker** with the bucket bound to it, serving the static page plus a small
  JSON API (`list`, `get`, `put command`, `put settings`, `keep`). The browser never sees storage
  credentials, only a Cloudflare Access session.
- **Login** is **Cloudflare Access** in front of the site: allow only the owner's e-mail, identity from
  Google *or* a one-time e-mail code (no Google at all). Google as an identity provider needs only the
  basic `openid email profile` scopes, so that Google client can be published to production with no
  verification and no 7-day problem. The Worker should also **verify the Access JWT itself**
  (`Cf-Access-Jwt-Assertion`), so a mis-configured Access rule cannot expose the bucket.
- **Retention** moves from our prune code to an R2 **lifecycle rule** (expire `shots/` and `recordings/`
  after 14 days; leave `keep/` alone). `bin/upload.sh` prune and the Drive "rate limit" backoff become
  unnecessary (kept harmless).
- **Netlify is dropped**: Access can only front sites served through Cloudflare, so the page moves.

### What it costs us

| | Today (Drive) | R2 |
|---|---|---|
| Money | free | Free tier: 10 GB storage, 1M "Class A" and 10M "Class B" operations per month, **no egress fees**. Above that it is metered (about $0.015 per GB-month) with **no hard spending cap**. **Whether a payment card is needed to turn R2 on is unconfirmed** (see below). |
| Fit with "free only, no paid services" | yes | only if a card on file is acceptable; usage stays far below the limits |
| Permission blast radius | rclone token reads/writes the **entire Drive** | a token for **one bucket** |
| Browser | holds a full-Drive token | holds nothing |
| Rate limits | hit them | none comparable |
| Login expiry | 7 days unless "In production" | none (static keys) |
| Phone commands | Drive app folders, or the web page | the web page only |
| Browsing files | Drive app, Photos-style | the web page only |
| Moving parts | rclone, Drive, static page | rclone, R2, Worker, Access, page (one vendor) |
| New code | none | Worker (~150 lines), web client rewrite (`drive.js` becomes `api.js`), a setup script |

**Rough usage per month:** about 8.6k shot uploads, 8.6k status writes, about 43k control-folder
listings (one per minute), plus page views, so well under **100k Class A** operations against 1M free.
Storage: about 40 MB a day times 14 days, so roughly **0.6 GB** plus whatever you Keep.

### Things to verify BEFORE committing (owner, about 15 minutes)

1. **Does enabling R2 require adding a payment method?** (I could not confirm from the docs I could reach.)
   If yes: is that acceptable given the "free only" rule? If not, Part B is off.
2. **Can Cloudflare Access protect a `*.workers.dev` / `*.pages.dev` address**, or does it need a domain
   you own on Cloudflare? Check the Cloudflare docs on Access and `workers.dev`. (One third-party write-up
   used a custom domain. Not confirmed either way.)
3. **Does Cloudflare Zero Trust sign-up (needed for Access) ask for a card too?**
   Also: Netlify's free-plan limits changed in 2025 and I could not read Netlify's own pricing page from
   this sandbox; that matters only if Part B is rejected and Netlify stays.

### Migration steps (nothing is deleted until the last one)

Each step ends with `make check` green and a manual check on the Mac.

- **B0. Decide.** Answer Part D. Do the three checks above.
- **B1. Storage swap, no website yet.**
  - `bin/setup-r2.sh`: creates an S3/Cloudflare rclone remote from a bucket-scoped key (prompts for the
    key pair, never prints it, `chmod 600`), sets `no_check_bucket = true` if needed.
  - Teach the code that S3 has **no real folders**: markers become **zero-byte objects**
    (`control/snap-now`), so the folder code paths (`purge`, `rmdirs`, `mkdir`, "is dir" parsing) are
    skipped for the S3 backend. Marker age still comes from `lsf` modification time. Keep both
    behaviours behind a `STORE=drive|r2` setting so Drive keeps working while we migrate.
  - Replace the prune code path with a lifecycle rule (documented command or dashboard steps).
  - Tests: the existing suite already runs against rclone's *local* backend; add an S3-like run
    (the fake rclone treats folders as prefixes) and re-run all marker/upload/prune tests.
  - Mac check: `./bin/selftest.sh` (storage round trip, marker round trip) against R2.
- **B2. Worker + website.**
  - `worker/`: the Worker (`wrangler.toml`, R2 binding, API, Access-JWT check), static `web/` as assets.
  - `web/api.js` replaces `web/drive.js`; `logic.js` (settings table, health, names) stays as is.
    The settings whitelist stays duplicated and **tested to match** `bin/lib.sh`.
  - Tests: Worker logic with a fake R2 binding in node (like `tests/web_test.js` today): path
    traversal (`../`), only whitelisted prefixes, JWT check, command names whitelisted, settings
    validated server-side (same ranges as the Mac).
  - Cloudflare setup: bucket, API token, Access application (one allow rule: the owner's e-mail),
    deploy with `wrangler`. Steps go in `worker/README.md`.
- **B3. Cut over.** Copy history once (`rclone copy gdrive:mac-watch r2:<bucket>`), switch `STORE=r2` in
  `config.env`, re-run `./bin/install.sh`, watch `./bin/status.sh` for a day. Keep Drive as read-only
  history for a while.
- **B4. Remove Drive.** Revoke the rclone token at the Google account permissions page, delete the
  Desktop OAuth client, delete the Netlify site, delete `web/drive.js`, `bin/setup-oauth.sh`,
  `bin/setup-drive.sh` and the Drive backoff code. Update `README.md` and `CLAUDE.md`.

### Risks

- A Cloudflare account takeover exposes the data: turn on 2-step verification for it.
- The R2 free tier is not a hard cap: keep the lifecycle rule, the queue caps, and set a billing alert
  if Cloudflare offers one.
- The **Worker is code on the public internet** in front of private screenshots. It must be small,
  whitelist-only, and verify the Access token on its own. The security tests above exist for this.
- Lost "Drive app" convenience: files are only reachable through the website and rclone.
- More new, **untested-on-real-Cloudflare** code than any change so far (this sandbox cannot reach
  Cloudflare). Expect first-deploy rough edges, as with the Netlify page.

### Recommendation

1. Finish Part A **this week** if it is quick (it blocks nothing else).
2. If the answers to the three checks are acceptable (card or no card, workers.dev or domain), do B0 to
   B3 afterwards. The Mac side is mostly config, so the risk is concentrated in the Worker.
3. If a card is not acceptable, stay on Drive: publish the app, keep the Netlify page, and use the
   weekly-reconnect fallback in Part A only if publishing is impossible.

---

## Part C: Backlog (not scheduled)

- **"Mac went quiet" alert.** A scheduled Worker (Cloudflare Cron Triggers) checks `status.json` age
  and sends a free push (for example ntfy.sh) when a Mac that was awake, lid open and not paused
  stops reporting for 20 minutes. Needs Part B. Without it, the dashboard shows the age when you look.
- **`bin/update.sh`** on the Mac: `git pull`, re-run `install.sh`, restart agents. Fewer copy-paste steps.
- **Frontmost app name** in the status line (via `osascript`), so a shot has context. Needs an extra
  macOS permission; opt-in only.
- **Daily contact sheet / timelapse** of the day's shots with `ffmpeg` (optional dependency).
- **Idle-time trigger** (`HIDIdleTime`) as the no-permission alternative to Hammerspoon, if Hammerspoon
  proves flaky.
- **Download a day as a zip** from the website (Worker, Part B).

---

## Part D: Questions for the owner

1. Is a payment card on a Cloudflare account acceptable if it stays inside the free tier? (decides Part B)
2. Do you own a domain you would put on Cloudflare, or must it be `*.workers.dev`? (decides Access)
3. Login for the website: Google, or a one-time e-mail code (no Google client needed at all)?
4. Part B: replace Drive completely, or run both for a while? (plan above assumes both until B4)
5. How long should `keep/` data live, and what is the size limit you are comfortable with there?
6. Do you want the "Mac went quiet" alert (needs Part B)?
