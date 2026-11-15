// Tests for the web page: shared logic, the page wiring, and web/api.js against the REAL
// Worker code (worker/core.js with node:sqlite and a fake B2).   node tests/web_test.js
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const L = require("../web/logic.js");
const A = require("../web/api.js");
const ROOT = path.join(__dirname, "..");

let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; console.log("  ok   " + msg); } else { fails++; console.log("  FAIL " + msg); } }
function eq(a, b, msg) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, msg + (s ? "" : "  got " + JSON.stringify(a))); }

(async () => {
  // ---- the settings table must match bin/lib.sh (remote_bounds) -------------------------
  const sh = (script) => execFileSync("sh", ["-c", script], { env: Object.assign({}, process.env, { MW_BIN: path.join(ROOT, "bin") }), encoding: "utf8" }).trim();
  const shellKeys = sh('. "$MW_BIN/lib.sh"; remote_keys').split(/\s+/).sort();
  eq(L.macKeys().slice().sort(), shellKeys, "web Mac settings keys == shell whitelist");
  L.SETTINGS.filter((s) => !s.worker).forEach((s) => {
    eq(sh('. "$MW_BIN/lib.sh"; remote_bounds ' + s.key), s.min + " " + s.max, "bounds of " + s.key + " match the shell");
  });
  L.SETTINGS.filter((s) => s.worker).forEach((s) => {
    eq(sh('. "$MW_BIN/lib.sh"; remote_bounds ' + s.key), "", s.key + " is Worker-only (the Mac refuses it)");
  });
  L.SETTINGS.forEach((s) => ok(s.def >= s.min && s.def <= s.max, "default of " + s.key + " is in range"));

  // ---- page wiring ------------------------------------------------------------------------
  const html = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "web/app.js"), "utf8");
  const apijs = fs.readFileSync(path.join(ROOT, "web/api.js"), "utf8");
  const used = new Set(); let mm; const re = /\$\("([a-z0-9-]+)"\)/g;
  while ((mm = re.exec(app))) used.add(mm[1]);
  // ids built from a list: nav-<screen>, screen-<screen>, root-<kind>
  for (const s of ["home", "files", "storage", "settings"]) { used.add("nav-" + s); used.add("screen-" + s); }
  for (const k of ["shots", "recordings", "keep"]) used.add("root-" + k);
  const missing = [...used].filter((id) => html.indexOf('id="' + id + '"') < 0);
  eq(missing, [], "every $(id) used by app.js exists in index.html (" + used.size + " ids)");
  ok(/\$\("set-" \+ s\.key\)/.test(app), "settings inputs are built dynamically from the table");
  ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(app + apijs), "no HTML injection or eval anywhere (textContent only)");
  ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline scripts (CSP script-src 'self')");
  ok(!/\son[a-z]+\s*=/.test(html), "no inline event handlers");
  ok(!/window\.(alert|confirm|prompt)\(|[^.\w](alert|confirm|prompt)\(/.test(app), "no native alert/confirm/prompt (a <dialog> is used)");
  ok(!/client_secret|GOCSPX|refresh_token|B2_APP_KEY|applicationKey/i.test(app + apijs + html), "no secrets in the web files");
  ok(fs.readFileSync(path.join(ROOT, "web/.assetsignore"), "utf8").includes("README.md"), "web/README.md is not published");
  const css = fs.readFileSync(path.join(ROOT, "web/style.css"), "utf8");
  const fonts = [...css.matchAll(/url\("(fonts\/[^"]+)"\)/g)].map((m) => m[1]);
  ok(fonts.length === 2 && fonts.every((f) => fs.existsSync(path.join(ROOT, "web", f))), "both self-hosted fonts exist (CSP allows fonts from this site only)");
  ok(fs.readdirSync(path.join(ROOT, "web/fonts")).filter((f) => /^LICENSE/.test(f)).length === 2, "font licences (OFL) ship with the fonts");
  ok(!fs.existsSync(path.join(ROOT, "web/drive.js")) && !fs.existsSync(path.join(ROOT, "netlify.toml")), "Drive client and Netlify config are gone");

  // ---- logic ------------------------------------------------------------------------------
  eq(L.validateSettings({ INTERVAL_SEC: "120", JPEG_QUALITY: "", KEEP_AWAKE: 1 }), { values: { INTERVAL_SEC: 120, KEEP_AWAKE: 1 }, errors: [] }, "validateSettings keeps valid numbers, skips empty");
  ok(L.validateSettings({ RECORD_SEC: 2000 }).errors.length === 1, "out of range refused");
  ok(L.validateSettings({ INTERVAL_SEC: "1.5" }).errors.length === 1, "non-integers refused");
  ok(L.validateSettings({ INTERVAL_SEC: "$(touch x)" }).errors.length === 1, "text refused");
  ok(L.validateSettings({ EVIL: 1 }).errors.length === 1, "unknown keys refused");
  eq(L.effective({}, "RETENTION_DAYS"), 14, "effective: default when not overridden");
  eq(L.effective({ RETENTION_DAYS: 30 }, "RETENTION_DAYS"), 30, "effective: override");
  eq([L.seenHealth(1000, 1100).level, L.seenHealth(1000, 1000 + 12 * 60).level, L.seenHealth(1000, 1000 + 30 * 60).level, L.seenHealth(0, 5).level],
     ["ok", "warn", "bad"].concat(["bad"]), "seen: green < 8 min, amber < 20, red above, red when never");
  ok(/asleep, offline, lid closed, or PAUSE file/.test(L.seenHealth(1000, 1000 + 3600).text), "red explains why");
  eq(L.parseShotName("20261113-152800-space.jpg"), { date: "2026-11-13", time: "15:28:00", reason: "space" }, "shot name parsed");
  eq(L.parseShotName("20261113-152800-space-2.jpg").reason, "space", "collision suffix ignored");
  eq(L.parseShotName("junk.jpg"), { date: "", time: "", reason: "" }, "junk name tolerated");
  eq([L.formatBytes(500), L.formatBytes(2048), L.formatBytes(5e6), L.formatBytes(10e9)], ["500 B", "2 KB", "5.0 MB", "10.00 GB"], "formatBytes uses decimal units like Backblaze (10 GB free = 10.00 GB)");
  eq(L.parseKey("shots/2026-11-15/a.jpg"), { kind: "shots", day: "2026-11-15", name: "a.jpg" }, "parseKey");
  for (const bad of ["shots/2026-11-15/../a.jpg", "../shots/2026-11-15/a.jpg", "/shots/2026-11-15/a.jpg", "shots/2026-11-15/a b.jpg", "x/2026-11-15/a.jpg", "live/../a.jpg", "shots/2026-11-15/a.exe", null]) {
    ok(L.parseKey(bad) === null, "parseKey refuses " + JSON.stringify(bad));
  }
  eq(A.encodeKey("shots/2026-11-15/a b#.jpg"), "shots/2026-11-15/a%20b%23.jpg", "encodeKey per segment");

  // ---- api.js against the real Worker code ------------------------------------------------
  const { makeApp, sha256hex } = await import("../worker/core.js");
  const { makeD1, makeFakeB2, makeAssets, makeGoogle } = await import("./fakes.mjs");
  const google = makeGoogle();
  let t = 1763200000;
  const b2 = makeFakeB2();
  const worker = makeApp({ now: () => t, random: () => 0.99, googleKeys: async () => google.keys, b2: b2.factory });
  const env = { DB: makeD1(), ASSETS: makeAssets(), MAC_TOKEN_HASH: await sha256hex("m".repeat(40)), SESSION_SECRET: "s".repeat(32),
                ALLOWED_EMAIL: "me@example.com", GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", B2_BUCKET: "b", B2_KEY_ID: "k", B2_APP_KEY: "a" };
  let cookie = "";
  const fetchFn = async (p, o) => {
    const h = Object.assign({}, o.headers || {});
    if (cookie) h.Cookie = cookie;
    const r = await worker.fetch(new Request("https://x.workers.dev" + p, { method: o.method, headers: h, body: o.body }), env, { waitUntil() {} });
    const sc = r.headers.get("Set-Cookie");
    if (sc) cookie = sc.split(";")[0];
    return r;
  };
  const api = A.makeApi(fetchFn);
  const mac = (method, p, body) => worker.fetch(new Request("https://x.workers.dev" + p, { method, headers: { Authorization: "Bearer " + "m".repeat(40) }, body }), env, {});

  eq((await api.config()).configured, true, "api.config");
  let e = await api.status().catch((x) => x);
  eq(e.status, 401, "api.status before sign-in rejects with status 401 (the page shows sign-in)");
  await api.signIn(google.sign({ iss: "accounts.google.com", aud: env.GOOGLE_CLIENT_ID, exp: t + 600, iat: t, email: "me@example.com", email_verified: true }));
  ok(cookie.startsWith("__Host-mw="), "api.signIn: session cookie set");
  eq((await api.status()).lastSeen, 0, "api.status after sign-in");
  await api.command("snap");
  ok(/cmd \d+ snap/.test(await (await mac("GET", "/mac/poll")).text()), "api.command reaches the Mac's poll");
  await api.watching();
  ok((await api.status()).watching, "api.watching switches on fast polling");
  e = await api.saveSettings({ INTERVAL_SEC: 5 }).catch((x) => x);
  ok(e.status === 400 && e.details.length === 1, "api.saveSettings: server errors come back with details");
  await api.saveSettings({ INTERVAL_SEC: 120 });
  eq((await api.settings()).values, { INTERVAL_SEC: 120 }, "api.settings round trip");
  b2.put("shots/2026-11-15/20261115-120000-space.jpg", "IMG");
  await mac("POST", "/mac/index", "shots/2026-11-15/20261115-120000-space.jpg 3 space");
  eq((await api.days("shots")).days[0].day, "2026-11-15", "api.days");
  const f = await api.files("shots", "2026-11-15", "", 60);
  eq(f.files[0].name, "20261115-120000-space.jpg", "api.files");
  const img = await fetchFn(api.imgUrl(f.files[0].key), { method: "GET" });
  eq(await img.text(), "IMG", "api.imgUrl serves the image with the session cookie");
  eq((await api.purge({ mode: "keys", keys: [f.files[0].key], dryRun: true })).files, 1, "api.purge dry run");
  eq((await api.keep([f.files[0].key])).kept, ["keep/2026-11-15/20261115-120000-space.jpg"], "api.keep");
  ok((await api.storage()).byKind.keep.files === 1, "api.storage");
  await api.signOut();
  e = await api.status().catch((x) => x);
  eq(e.status, 401, "api.signOut ends the session");

  console.log("\n" + passes + " passed, " + fails + " failed");
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.log("  FAIL crashed: " + (err && err.stack)); process.exit(1); });
