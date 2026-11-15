# mac-watch dashboard (optional)

A static web page for your phone: see whether the Mac is alive, take a screenshot, start a
recording, pause/resume, change settings, browse shots, and tap **Keep** on the ones to archive.

**How it works.** Netlify only serves these files. There is no server, no database, no login
system of its own, and no secret anywhere on the site. The page signs you in with **Google**
and then talks straight to **your Google Drive**, the same folder the Mac uploads to. The Mac
and the page never talk to each other; they leave notes in Drive (`control/`) that the other
reads. So protection comes from Google: without signing in to your account, the page shows
nothing. (Netlify's own password protection is a paid feature, which is why it is not used.)

## Set up (about 15 minutes, free)

1. **Google client for the page.** In the Google Cloud console, same project as before:
   *APIs & Services, Credentials, Create credentials, OAuth client ID*, application type
   **Web application**. Under **Authorised JavaScript origins** add
   `https://butter-bot.netlify.app` (use your real Netlify address) and, for testing on your
   laptop, `http://localhost:8080`. No redirect URI is needed. Create it and copy the **Client
   ID**. (The page does not use the client secret; ignore it.)
   While the consent screen is in "Testing", your own Google account must be listed under
   *Audience, Test users*.
2. **Put the ID in `web/config.js`** (`clientId:`) and push it to GitHub. A client ID is public by
   design; it is safe in the repo.
3. **Netlify.** *Add new site, Import an existing project, GitHub*, pick this repo, branch
   `main`. Leave the build command empty. `netlify.toml` already sets the publish folder to
   `web`. Name the site `butter-bot` to get `butter-bot.netlify.app`.
   If Netlify marks the site **private** (new free teams may default to that), the page will ask
   for a Netlify login first. Either log in to Netlify on your phone, or set the site to public in
   *Site configuration, Visitor access*: the page holds no secrets.
4. **Open the address, tap Sign in with Google.** Google warns that the app is unverified (it is
   yours): *Advanced, continue, Allow*. Tick the Drive permission.

Try it on your laptop first:

```sh
cd web && python3 -m http.server 8080      # then open http://localhost:8080
```

## What it can and cannot do

- Commands are the same Drive "markers" the Mac already understands: `snap-now`, `record-5min`,
  `pause`, `resume`. The page just creates them for you, so the folder-naming trick is gone from
  your daily life.
- **Settings** are written to `control/config.remote`. The Mac accepts **only** a fixed list of
  numbers inside fixed ranges (screenshot interval, JPEG quality, gaps, retention, record length,
  keep-awake, ...). It can never change the Drive folder, run a command or add flags. Remove the
  settings (button on the page, or delete the file) and the Mac returns to `config.env`.
- **Pause from the page** stops capturing, recording and uploading but keeps the Mac checking
  Drive so that **Resume** can reach it. The **PAUSE file on the Mac** is stronger: it stops
  everything, including talking to Drive, and cannot be undone from the page.
- **Status** (`control/status.json`) is refreshed about every 5 minutes while the Mac is awake with
  the lid open. If the page says "last seen 40 minutes ago", the Mac is asleep, offline, has the lid
  shut, or has the PAUSE file. It contains times, counts, battery and error text, never screen
  content.
- The token Google gives the page lives in memory for about an hour and is not stored. **Sign out**
  revokes it. The page asks for the same full-Drive scope as rclone does (see the main README for
  the trade-off).
- Only deploy this page from **your own repo**: it holds a Drive-scoped token while open, so its
  code is as trusted as your Mac's.
