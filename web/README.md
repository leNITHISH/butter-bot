# mac-watch web page

The phone/laptop page: is the Mac alive, **Screenshot now**, **Live view**, **Record**,
**Pause/Resume**, a file explorer (download one shot to the phone, Keep, delete, clean up by
age), a storage monitor and settings.

Address: **https://butter-bot.butter-bot-worker.workers.dev**

## How it works

```
 Mac --rclone (b2)---------> Backblaze B2 (private bucket: the bytes)
 Mac <--poll 20 s / 2 s----> Cloudflare Worker "butter-bot" + D1 <--cookie-- this page
                              |- serves these files (web/) with a strict CSP
                              '- streams images/videos from B2 (no B2 key in the browser)
```

- The page and the Worker are one origin. The Worker serves `web/` as static assets and adds the
  security headers (CSP, nosniff, no-referrer, noindex, no framing) to every response.
- **Sign in with Google** (identity only, no Google API access). The Worker verifies Google's
  signed ID token itself (signature, issuer, audience, expiry, verified e-mail) and lets in only
  `ALLOWED_EMAIL`. It then sets a signed `__Host-` cookie: `HttpOnly; Secure; SameSite=Strict`,
  14 days. **Sign out** signs out every device.
- Every state change also needs the header `X-MW: 1` and a JSON body, so another site cannot
  submit a form at it.
- The Mac never accepts connections. It polls `GET /mac/poll` with its own token (the Worker
  only stores the token's SHA-256). While this page is open it pings `/api/watching` and the Mac
  polls every 2 s instead of 20 s, so **Screenshot now** arrives in seconds.
- The file list, commands, status and settings live in **D1**; B2 is never listed by the page
  (B2's free daily list allowance is small). A daily job reconciles D1 with the real bucket.
- Deleting: **purge** always shows "N files, X MB" first. A cron job every 15 minutes applies
  `RETENTION_DAYS` and the **storage guard** (above `STORAGE_SOFT_LIMIT_GB`, default 8 GB, the
  oldest non-Keep days go first). `keep/` is only ever deleted when you delete a kept file by hand.

Look: the owner's **blafortree** design system (a Claude Design System artifact): cream paper,
ink, orange marks, square corners, lines instead of cards, uppercase mono captions, words instead
of icons, light only. Fonts: Atkinson Hyperlegible Next and Mono, self-hosted in `web/fonts/`
(OFL, licences beside them) because the CSP allows fonts from this site only. Screenshot reasons
wear the system's accent colours.

Files is a timeline (`app.js`) with a full-screen viewer (`gallery.js`, no library): swipe across
days (it loads more as you go), pinch / double-tap / wheel zoom, pan, pull down or Back to close,
tap to hide the bars, the Fullscreen API where the browser has it (not on iPhone, where the viewer
already fills the screen), keep / delete / download / info in place. The thumbnail shows first,
the full image replaces it when loaded, and the neighbours load a moment later so a swipe lands
on a sharp picture (each full image is one B2 download; the browser caches them).

Code: `worker/core.js` (all logic, tested in node), `worker/b2.js` (B2 native API),
`worker/index.js` (Cloudflare glue), `worker/schema.sql`, `worker/wrangler.toml`. Page:
`index.html`, `app.js`, `api.js`, `logic.js` (shared with the Worker), `style.css`.

## Secrets (`./worker/put-secrets.sh`, hidden input; never in git)

| Secret | What |
|---|---|
| `B2_BUCKET`, `B2_KEY_ID`, `B2_APP_KEY` | the **macwatch-worker** Backblaze key, limited to the bucket (checked with Backblaze before saving) |
| `ALLOWED_EMAIL` | the only Google account that may sign in |
| `GOOGLE_CLIENT_ID` | the *Web application* OAuth client (public; origins: the workers.dev URL and `http://localhost:8787`) |
| `SESSION_SECRET` | random; making a new one signs everyone out |
| `MAC_TOKEN_HASH` | SHA-256 of the Mac token, printed by `./bin/setup-remote.sh` on the Mac |

`./worker/put-secrets.sh NAME` sets just one. Secrets apply at once, no redeploy needed.

## Deploy (laptop)

```sh
cd worker
npm install                 # wrangler, pinned in package-lock.json
npx wrangler login          # once, browser consent
npx wrangler d1 execute macwatch --remote --file schema.sql   # once (safe to repeat)
npx wrangler deploy         # or from the repo root: make deploy
```

The D1 database id and the cron schedule are in `wrangler.toml`. Logs: `npx wrangler tail`
(sign-in refusals are logged with the reason only, never the token).

## Free plan limits

Workers: 100,000 requests/day (idle polling is about 4,300). Each request may make about 50
outgoing calls, so purge and the cron jobs work in batches of 40 and the page repeats until done.
The **Storage** screen shows today's estimated usage of Worker requests and B2 downloads.
