// Tests for the Worker (worker/core.js + worker/b2.js) with node:sqlite as D1 and fakes for B2,
// ASSETS and Google.  Run: node tests/worker_test.mjs   (tests/run.sh runs it too)
import { makeApp, sha256hex, ctEqual, CSP } from "../worker/core.js";
import { makeB2 } from "../worker/b2.js";
import { makeD1, makeFakeB2, makeAssets, makeGoogle } from "./fakes.mjs";
import Logic from "../web/logic.js";

let passes = 0, fails = 0;
const ok = (c, m) => { if (c) { passes++; console.log("  ok   " + m); } else { fails++; console.log("  FAIL " + m); } };
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, m + (s ? "" : "  got " + JSON.stringify(a) + " want " + JSON.stringify(b))); };

const BASE = "https://butter-bot.example.workers.dev";
const MAC_TOKEN = "a".repeat(20) + "macTokenValue0123456789abcdef";
const SECRETS = {
  SESSION_SECRET: "session-secret-SUPERSECRET-0123456789",
  ALLOWED_EMAIL: "Owner@Example.com",
  GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
  B2_KEY_ID: "keyid-SECRETKEYID",
  B2_APP_KEY: "appkey-SUPERSECRETB2KEY",
  B2_BUCKET: "macwatch-test"
};
const google = makeGoogle();

async function setup(opts = {}) {
  let clock = opts.t || 1763200000;
  const b2 = makeFakeB2();
  const app = makeApp({ now: () => clock, random: () => (opts.count ? 0 : 0.99), googleKeys: async () => google.keys, b2: b2.factory });
  const env = Object.assign({ DB: makeD1(), ASSETS: makeAssets(), MAC_TOKEN_HASH: await sha256hex(MAC_TOKEN) }, SECRETS, opts.env || {});
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const S = {
    app, env, b2, ctx,
    get t() { return clock; }, set t(v) { clock = v; },
    async req(method, path, o = {}) {
      const h = Object.assign({}, o.headers || {});
      if (o.cookie) h.Cookie = o.cookie;
      if (o.mac) h.Authorization = "Bearer " + (o.mac === true ? MAC_TOKEN : o.mac);
      let body = o.body;
      if (o.json !== undefined) { body = JSON.stringify(o.json); h["Content-Type"] = h["Content-Type"] || "application/json"; if (o.xmw !== false) h["X-MW"] = "1"; }
      const res = await app.fetch(new Request(BASE + path, { method, headers: h, body }), env, ctx);
      await Promise.all(waits.splice(0));
      return res;
    },
    async login() {
      const tok = google.sign({ iss: "https://accounts.google.com", aud: SECRETS.GOOGLE_CLIENT_ID, exp: clock + 3600, iat: clock, email: "owner@example.com", email_verified: true });
      const r = await S.req("POST", "/auth/google", { json: { credential: tok } });
      const c = r.headers.get("Set-Cookie") || "";
      S.cookie = c.split(";")[0];
      return r;
    },
    api(method, path, json) { return S.req(method, path, { cookie: S.cookie, json }); },
    async poll(q) { const r = await S.req("GET", "/mac/poll" + (q || "?paused=no"), { mac: true }); return { status: r.status, text: await r.text() }; }
  };
  return S;
}

const leaks = [MAC_TOKEN, SECRETS.SESSION_SECRET, SECRETS.B2_APP_KEY, SECRETS.B2_KEY_ID, "owner@example.com", "Owner@Example.com"];
async function noSecret(res, label) {
  const body = await res.clone().text();
  const all = body + JSON.stringify([...res.headers].filter(([k]) => k.toLowerCase() !== "set-cookie"));
  ok(!leaks.some((s) => all.includes(s)), "no secret in the response: " + label);
}

// =======================================================================================
console.log("== auth: Google sign-in");
{
  const S = await setup();
  let r = await S.req("GET", "/auth/config");
  const cfg = await r.json();
  eq(cfg, { clientId: SECRETS.GOOGLE_CLIENT_ID, configured: true }, "/auth/config gives the public client id only");
  r = await S.login();
  eq(r.status, 200, "valid Google token for the allowed e-mail (any case): signed in");
  const sc = r.headers.get("Set-Cookie");
  ok(/^__Host-mw=[^;]+; Path=\/; Max-Age=1209600; HttpOnly; Secure; SameSite=Strict$/.test(sc), "cookie is __Host-, HttpOnly, Secure, SameSite=Strict, 14 days");
  r = await S.api("GET", "/api/status");
  eq(r.status, 200, "session cookie opens /api");

  const base = { iss: "https://accounts.google.com", aud: SECRETS.GOOGLE_CLIENT_ID, exp: S.t + 3600, iat: S.t, email: "owner@example.com", email_verified: true };
  const bad = {
    "wrong e-mail": google.sign(Object.assign({}, base, { email: "someone@example.com" })),
    "wrong audience": google.sign(Object.assign({}, base, { aud: "other.apps.googleusercontent.com" })),
    "expired": google.sign(Object.assign({}, base, { exp: S.t - 1 })),
    "wrong issuer": google.sign(Object.assign({}, base, { iss: "https://evil.example" })),
    "unverified e-mail": google.sign(Object.assign({}, base, { email_verified: false })),
    "signed by another key": google.sign(base, { wrongKey: true }),
    "unknown key id": google.sign(base, { kid: "nope" }),
    "alg none": google.sign(base, { alg: "none" }),
    "garbage": "a.b.c",
    "missing": undefined
  };
  for (const [name, tok] of Object.entries(bad)) {
    const rr = await S.req("POST", "/auth/google", { json: { credential: tok } });
    ok(rr.status === 403 && !rr.headers.get("Set-Cookie"), "refused: " + name);
  }
  r = await S.req("POST", "/auth/google", { json: { credential: "x" }, xmw: false });
  eq(r.status, 403, "sign-in without the X-MW header is refused");
  const S2 = await setup({ env: { ALLOWED_EMAIL: "" } });
  r = await S2.req("POST", "/auth/google", { json: { credential: google.sign(base) } });
  eq(r.status, 503, "no ALLOWED_EMAIL configured: nobody can sign in");
}

console.log("== auth: cookies, CSRF, logout");
{
  const S = await setup();
  await S.login();
  const [name, val] = S.cookie.split("=");
  const [p, sig] = val.split(".");
  const tampered = JSON.parse(Buffer.from(p, "base64url").toString());
  tampered.exp += 999999;
  const forged = name + "=" + Buffer.from(JSON.stringify(tampered)).toString("base64url") + "." + sig;
  for (const [label, c] of [["no cookie", ""], ["tampered payload", forged], ["bad signature", name + "=" + p + "." + sig.slice(0, -2) + "xx"], ["junk", name + "=junk"]]) {
    for (const path of ["/api/status", "/img/shots/2026-11-15/20261115-120000-space.jpg", "/dl/shots/2026-11-15/20261115-120000-space.jpg"]) {
      const r = await S.req("GET", path, { cookie: c });
      ok(r.status === 401, label + ": " + path + " refused");
    }
  }
  S.t += 15 * 86400;
  eq((await S.api("GET", "/api/status")).status, 401, "cookie older than 14 days: refused");
  S.t -= 15 * 86400;
  let r = await S.req("POST", "/api/command", { cookie: S.cookie, json: { name: "snap" }, xmw: false });
  eq(r.status, 403, "state change without X-MW: refused");
  r = await S.req("POST", "/api/command", { cookie: S.cookie, body: JSON.stringify({ name: "snap" }), headers: { "X-MW": "1", "Content-Type": "text/plain" } });
  eq(r.status, 403, "state change with a non-JSON content type: refused");
  r = await S.req("POST", "/api/command", { cookie: S.cookie, json: { name: "snap" }, headers: { Origin: "https://evil.example" } });
  eq(r.status, 403, "state change from another Origin: refused");
  r = await S.req("POST", "/api/command", { cookie: S.cookie, json: { name: "snap" }, headers: { Origin: BASE } });
  eq(r.status, 200, "same Origin: allowed");
  const before = S.cookie;
  r = await S.req("POST", "/auth/logout", { cookie: S.cookie, json: {} });
  eq(r.status, 200, "logout ok");
  ok(/Max-Age=0/.test(r.headers.get("Set-Cookie")), "logout clears the cookie");
  eq((await S.req("GET", "/api/status", { cookie: before })).status, 401, "logout invalidates every existing session (epoch)");
  await S.login();
  eq((await S.api("GET", "/api/status")).status, 200, "a new sign-in works after logout");
}

console.log("== Mac token");
{
  const S = await setup();
  let r = await S.req("GET", "/mac/poll", {});
  eq(r.status, 401, "no token: 401");
  r = await S.req("GET", "/mac/poll", { mac: "b".repeat(48) });
  eq(r.status, 401, "wrong token: 401");
  eq(await r.text(), "", "Mac errors are a bare status code");
  r = await S.req("GET", "/api/status", { mac: true });
  eq(r.status, 401, "the Mac token cannot use /api");
  r = await S.req("GET", "/img/shots/2026-11-15/20261115-120000-space.jpg", { mac: true });
  eq(r.status, 401, "the Mac token cannot read images");
  await S.login();
  r = await S.req("GET", "/mac/poll", { cookie: S.cookie });
  eq(r.status, 401, "a browser session cannot use /mac");
  const S2 = await setup({ env: { MAC_TOKEN_HASH: "" } });
  eq((await S2.poll()).status, 401, "no MAC_TOKEN_HASH configured: every Mac request refused");
  ok(ctEqual("abc", "abc") && !ctEqual("abc", "abd") && !ctEqual("abc", "abcd"), "ctEqual");
}

console.log("== poll, commands, ack, fast/live, settings");
{
  const S = await setup();
  await S.login();
  let p = await S.poll();
  eq(p.text, "fast 0\nlive 0\n", "idle poll: plain text, fast 0, live 0, nothing else");
  let st = await (await S.api("GET", "/api/status")).json();
  eq([st.lastSeen, st.macPaused], [S.t, "no"], "poll records last seen + pause state");
  eq((await S.api("POST", "/api/command", { name: "snap" })).status, 200, "snap command accepted");
  const dup = await (await S.api("POST", "/api/command", { name: "snap" })).json();
  ok(dup.duplicate === true, "double tap within 10 s is one command");
  eq((await S.api("POST", "/api/command", { name: "rm -rf" })).status, 400, "unknown command refused");
  S.t += 1;
  await S.api("POST", "/api/command", { name: "record" });
  p = await S.poll();
  const lines = p.text.trim().split("\n");
  eq(lines[0], "fast 1", "a command switches on fast polling");
  ok(/^cmd 1 snap \d+$/.test(lines[2]) && /^cmd 2 record \d+$/.test(lines[3]), "commands in id order: cmd <id> <name> <time>");
  let r = await S.req("POST", "/mac/ack", { mac: true, body: "1" });
  eq(r.status, 204, "ack");
  await S.req("POST", "/mac/ack", { mac: true, body: "1" });
  eq((await S.req("POST", "/mac/ack", { mac: true, body: "1; DROP TABLE x" })).status, 400, "ack accepts only a number");
  p = await S.poll();
  ok(!/cmd 1 /.test(p.text) && /cmd 2 record/.test(p.text), "acked command is not sent again (ack is idempotent)");
  S.t += 601;
  p = await S.poll();
  eq(p.text.split("\n")[0], "fast 0", "fast mode ends 10 min after the last page activity");
  await S.api("POST", "/api/watching", {});
  eq((await S.poll()).text.split("\n")[0], "fast 1", "page open (watching): fast 1");
  await S.api("POST", "/api/command", { name: "live-on" });
  eq((await S.poll()).text.split("\n")[1], "live 1", "live-on: live 1");
  S.t += 500; await S.api("POST", "/api/watching", {}); S.t += 500;
  eq((await S.poll()).text.split("\n")[1], "live 1", "watching extends live");
  await S.api("POST", "/api/command", { name: "live-off" });
  eq((await S.poll()).text.split("\n")[1], "live 0", "live-off: live 0");
  S.t += 2 * 86400;
  await S.app.every15(S.env);
  eq((await S.env.DB.prepare("SELECT COUNT(*) n FROM commands").first()).n, 0, "cron deletes commands older than a day");

  // settings
  r = await S.api("PUT", "/api/settings", { values: { INTERVAL_SEC: 120, JPEG_QUALITY: "50", RETENTION_DAYS: 30, STORAGE_SOFT_LIMIT_GB: 5 } });
  eq(r.status, 200, "valid settings saved");
  p = await S.poll();
  ok(/set INTERVAL_SEC=120\n/.test(p.text) && /set JPEG_QUALITY=50\n/.test(p.text) && /set RETENTION_DAYS=30\n/.test(p.text), "set lines for Mac settings");
  ok(!/STORAGE_SOFT_LIMIT_GB/.test(p.text), "Worker-only settings are not sent to the Mac");
  for (const [label, v] of [["out of range", { KEEP_AWAKE: 5 }], ["text", { INTERVAL_SEC: "$(reboot)" }], ["fraction", { INTERVAL_SEC: 1.5 }],
                            ["unknown key", { RCLONE_REMOTE: 1 }], ["not an object", [1, 2]], ["newline", { INTERVAL_SEC: "120\nset X=1" }]]) {
    r = await S.api("PUT", "/api/settings", { values: v });
    ok(r.status === 400, "settings refused: " + label);
  }
  p = await S.poll();
  ok(/set INTERVAL_SEC=120\n/.test(p.text), "refused updates leave the saved settings alone");
  await S.api("PUT", "/api/settings", { values: {} });
  p = await S.poll();
  ok(!/^set /m.test(p.text), "empty settings: no set block (the Mac drops its overrides)");
  const g = await (await S.api("GET", "/api/settings")).json();
  eq(g.table.length, Logic.SETTINGS.length, "settings table is served to the page");
}

console.log("== status, index, files, days, live");
{
  const S = await setup();
  await S.login();
  let r = await S.req("POST", "/mac/status", { mac: true, body: JSON.stringify({ updated: S.t, lid: "open", diskFreeGB: 40, queueMB: 3, queue: 2 }) });
  eq(r.status, 204, "status accepted");
  eq((await S.req("POST", "/mac/status", { mac: true, body: "not json" })).status, 400, "status must be JSON");
  eq((await S.req("POST", "/mac/status", { mac: true, body: "x".repeat(20000) })).status, 413, "status size is capped");
  const st = await (await S.api("GET", "/api/status")).json();
  eq(st.status.diskFreeGB, 40, "the page gets the latest status");
  const idx = [
    "shots/2026-11-15/20261115-120000-space.jpg 1000 space",
    "thumbs/2026-11-15/20261115-120000-space.jpg 100 space",
    "shots/2026-11-15/20261115-120500-interval.jpg 2000 interval",
    "shots/2026-11-14/20261114-090000-remote.jpg 3000 remote",
    "recordings/2026-11-15/20261115-121000-rec.mov 50000 rec",
    "shots/../../etc/passwd 1 x",
    "keep/2026-11-15/a.jpg 5 x",
    "/shots/2026-11-15/x.jpg 5 x",
    "shots/2026-11-15/evil;rm.jpg 5 x",
    "shots/2026-11-15/ok.jpg notanumber x"
  ].join("\n");
  r = await S.req("POST", "/mac/index", { mac: true, body: idx });
  eq(await r.text(), "indexed 5 rejected 5\n", "index: whitelisted keys stored, traversal/keep/odd names rejected");
  let d = await (await S.api("GET", "/api/days?kind=shots")).json();
  eq(d.days, [{ day: "2026-11-15", files: 2, bytes: 3000 }, { day: "2026-11-14", files: 1, bytes: 3000 }], "days: newest first with count and bytes");
  let f = await (await S.api("GET", "/api/files?kind=shots&day=2026-11-15&limit=1")).json();
  eq(f.files.map((x) => x.name), ["20261115-120500-interval.jpg"], "files: newest first, paginated");
  eq(f.next, "20261115-120500-interval.jpg", "cursor for the next page");
  f = await (await S.api("GET", "/api/files?kind=shots&day=2026-11-15&limit=1&after=" + f.next)).json();
  eq([f.files[0].name, f.files[0].thumb, f.files[0].reason, f.next], ["20261115-120000-space.jpg", "thumbs/2026-11-15/20261115-120000-space.jpg", "space", null], "second page with thumbnail key and reason");
  eq((await S.api("GET", "/api/files?kind=shots&day=2026-11-15' OR 1=1--")).status, 400, "bad day refused");
  eq((await S.api("GET", "/api/files?kind=../x&day=2026-11-15")).status, 400, "bad kind refused");
  eq((await S.api("GET", "/api/days?kind=thumbs")).status, 400, "thumbs are not a root");
  r = await S.req("POST", "/mac/live", { mac: true, body: "live/20261115-120001.jpg 30000" });
  eq(r.status, 204, "live frame registered");
  eq((await S.req("POST", "/mac/live", { mac: true, body: "shots/2026-11-15/x.jpg" })).status, 400, "live accepts only live/ keys");
  eq((await (await S.api("GET", "/api/live")).json()).key, "live/20261115-120001.jpg", "page gets the newest live frame");
}

console.log("== /img and /dl: whitelist, streaming, ranges");
{
  const S = await setup();
  await S.login();
  S.b2.put("shots/2026-11-15/20261115-120000-space.jpg", "JPEGDATA");
  S.b2.put("recordings/2026-11-15/20261115-121000-rec.mov", "0123456789MOVIE");
  let r = await S.api("GET", "/img/shots/2026-11-15/20261115-120000-space.jpg");
  eq([r.status, await r.text(), r.headers.get("Content-Type")], [200, "JPEGDATA", "image/jpeg"], "image streamed from B2");
  ok(/private, max-age=31536000, immutable/.test(r.headers.get("Cache-Control")), "images are cached privately by the browser");
  ok(r.headers.get("Content-Security-Policy") === CSP, "CSP on image responses");
  r = await S.api("GET", "/dl/shots/2026-11-15/20261115-120000-space.jpg");
  eq(r.headers.get("Content-Disposition"), 'attachment; filename="20261115-120000-space.jpg"', "/dl is a download with a clean file name");
  r = await S.req("GET", "/img/recordings/2026-11-15/20261115-121000-rec.mov", { cookie: S.cookie, headers: { Range: "bytes=2-5" } });
  eq([r.status, await r.text(), r.headers.get("Content-Range")], [206, "2345", "bytes 2-5/15"], "video Range requests pass through (seeking)");
  for (const bad of ["/img/shots/2026-11-15/../../x.jpg", "/img/%2e%2e/%2e%2e/etc/passwd", "/img/shots%2F2026-11-15%2F..%2Fx.jpg", "/img//shots/2026-11-15/a.jpg",
                     "/img/other/2026-11-15/a.jpg", "/img/shots/2026-11-15/a.png", "/img/shots/2026-11-15/a%00.jpg", "/dl/live/../keep/a.jpg", "/img/%E0%A4%A"]) {
    r = await S.api("GET", bad);
    ok(r.status === 404 || r.status === 400, "refused key: " + bad);
  }
  ok(!S.b2.calls.includes("download") || S.b2.calls.filter((c) => c === "download").length === 3, "refused keys never reach B2");
  r = await S.api("GET", "/img/shots/2026-11-15/missing.jpg");
  eq(r.status, 404, "missing object: 404");
}

console.log("== keep");
{
  const S = await setup();
  await S.login();
  S.b2.put("shots/2026-11-15/20261115-120000-space.jpg", "AAAA");
  await S.req("POST", "/mac/index", { mac: true, body: "shots/2026-11-15/20261115-120000-space.jpg 4 space" });
  let r = await (await S.api("POST", "/api/keep", { keys: ["shots/2026-11-15/20261115-120000-space.jpg"] })).json();
  eq(r.kept, ["keep/2026-11-15/20261115-120000-space.jpg"], "keep: copied to keep/<day>/<name>");
  ok(S.b2.has("keep/2026-11-15/20261115-120000-space.jpg") && !S.b2.has("shots/2026-11-15/20261115-120000-space.jpg"), "keep: copy in B2, original deleted");
  const k = await (await S.api("GET", "/api/files?kind=keep&day=2026-11-15")).json();
  eq([k.files.length, k.files[0].reason], [1, "space"], "keep: indexed under keep with its reason");
  eq((await S.api("GET", "/api/days?kind=shots")).status === 200 && (await (await S.api("GET", "/api/days?kind=shots")).json()).days.length, 0, "keep: original row removed");
  r = await S.api("POST", "/api/keep", { keys: ["keep/2026-11-15/20261115-120000-space.jpg"] });
  eq(r.status, 400, "keep refuses keep/ keys");
  r = await S.api("POST", "/api/keep", { keys: Array(11).fill("shots/2026-11-15/a.jpg") });
  eq(r.status, 400, "keep: at most 10 keys per call");
}

console.log("== purge");
{
  const S = await setup({ t: Date.UTC(2026, 10, 15, 12) / 1000 });
  await S.login();
  const lines = [];
  for (const day of ["2026-11-01", "2026-11-02", "2026-11-14", "2026-11-15"]) {
    for (let i = 0; i < 3; i++) {
      const n = day.replace(/-/g, "") + "-10000" + i + "-interval.jpg";
      S.b2.put("shots/" + day + "/" + n, "x".repeat(1000)); lines.push("shots/" + day + "/" + n + " 1000 interval");
      S.b2.put("thumbs/" + day + "/" + n, "t".repeat(100)); lines.push("thumbs/" + day + "/" + n + " 100 interval");
    }
  }
  S.b2.put("keep/2026-11-01/old-kept.jpg", "k"); S.b2.put("recordings/2026-11-01/20261101-100000-rec.mov", "m".repeat(5000));
  lines.push("recordings/2026-11-01/20261101-100000-rec.mov 5000 rec");
  await S.req("POST", "/mac/index", { mac: true, body: lines.join("\n") });
  await S.env.DB.prepare("INSERT INTO files VALUES ('keep/2026-11-01/old-kept.jpg','keep','2026-11-01','old-kept.jpg',1,'',1)").run();
  let r = await (await S.api("POST", "/api/purge", { mode: "olderThanDays", days: 7, dryRun: true })).json();
  eq([r.dryRun, r.files, r.bytes], [true, 13, 3 * 2 * 1100 + 5000], "dry run: counts files and bytes, deletes nothing");
  eq(S.b2.names().length, 26, "dry run changed nothing in B2");
  r = await (await S.api("POST", "/api/purge", { mode: "olderThanDays", days: 7 })).json();
  ok(r.dryRun === true, "dryRun defaults to true (must be false explicitly to delete)");
  r = await (await S.api("POST", "/api/purge", { mode: "olderThanDays", days: 7, dryRun: false })).json();
  eq([r.deleted, r.more], [13, false], "real purge deletes them");
  ok(S.b2.has("keep/2026-11-01/old-kept.jpg"), "keep/ survives purge by age");
  ok(!S.b2.names().some((n) => n.includes("2026-11-0")) || S.b2.names().filter((n) => n.includes("2026-11-0")).every((n) => n.startsWith("keep/")), "old shots, thumbs and recordings gone from B2");
  r = await (await S.api("POST", "/api/purge", { mode: "day", day: "2026-11-14", dryRun: false })).json();
  eq(r.deleted, 6, "purge one day (shots + their thumbs)");
  r = await S.api("POST", "/api/purge", { mode: "day", day: "2026-11-15", kinds: ["keep"], dryRun: false });
  eq(r.status, 400, "purge by day never accepts keep");
  r = await (await S.api("POST", "/api/purge", { mode: "keys", keys: ["shots/2026-11-15/20261115-100000-interval.jpg"], dryRun: false })).json();
  eq(r.deleted, 2, "purge by key also removes its thumbnail");
  r = await (await S.api("POST", "/api/purge", { mode: "keys", keys: ["keep/2026-11-01/old-kept.jpg"], dryRun: false })).json();
  ok(r.deleted === 1 && !S.b2.has("keep/2026-11-01/old-kept.jpg"), "keep files are deleted only when named explicitly");
  for (const bad of [{ mode: "keys", keys: ["../x"] }, { mode: "day", day: "x" }, { mode: "olderThanDays", days: 0 }, { mode: "nope" }, { mode: "keys", keys: ["live/a.jpg"] }]) {
    r = await S.api("POST", "/api/purge", Object.assign({ dryRun: false }, bad));
    ok(r.status === 400, "purge refuses " + JSON.stringify(bad));
  }
}

console.log("== purge in batches (free plan subrequest limit)");
{
  const S = await setup({ t: Date.UTC(2026, 10, 15, 12) / 1000 });
  await S.login();
  const lines = [];
  for (let i = 0; i < 100; i++) {
    const n = "20261101-1" + String(i).padStart(5, "0") + "-interval.jpg";
    S.b2.put("shots/2026-11-01/" + n, "x"); lines.push("shots/2026-11-01/" + n + " 1 interval");
  }
  await S.req("POST", "/mac/index", { mac: true, body: lines.join("\n") });
  let r = await (await S.api("POST", "/api/purge", { mode: "day", day: "2026-11-01", dryRun: false })).json();
  ok(r.deleted > 0 && r.deleted < 100 && r.more === true, "one call deletes a batch and says there is more (" + r.deleted + ")");
  let rounds = 1;
  while (r.more && rounds < 10) { r = await (await S.api("POST", "/api/purge", { mode: "day", day: "2026-11-01", dryRun: false })).json(); rounds++; }
  eq([S.b2.names().length, r.more], [0, false], "repeating the call finishes the job (" + rounds + " calls)");
}

console.log("== cron: retention and storage guard");
{
  const S = await setup({ t: Date.UTC(2026, 10, 30, 12) / 1000 });
  await S.login();
  const lines = [];
  for (const day of ["2026-11-01", "2026-11-10", "2026-11-20", "2026-11-29"]) {
    const n = day.replace(/-/g, "") + "-100000-interval.jpg";
    S.b2.put("shots/" + day + "/" + n, "x"); lines.push("shots/" + day + "/" + n + " 1 interval");
  }
  S.b2.put("keep/2026-11-01/k.jpg", "k");
  await S.req("POST", "/mac/index", { mac: true, body: lines.join("\n") });
  await S.env.DB.prepare("INSERT INTO files VALUES ('keep/2026-11-01/k.jpg','keep','2026-11-01','k.jpg',1,'',1)").run();
  let out = await S.app.every15(S.env);
  eq(out.retention, 2, "default retention 14 days: the two old days are deleted");
  ok(S.b2.has("keep/2026-11-01/k.jpg"), "retention never touches keep/");
  await S.api("PUT", "/api/settings", { values: { RETENTION_DAYS: 3 } });
  out = await S.app.every15(S.env);
  eq([out.retention, S.b2.names()], [1, ["keep/2026-11-01/k.jpg", "shots/2026-11-29/20261129-100000-interval.jpg"]], "RETENTION_DAYS from the page is used");

  // guard: limit 1 GB, pretend 2.5 GB of shots over three days
  const G = await setup({ t: Date.UTC(2026, 10, 30, 12) / 1000 });
  await G.login();
  await G.api("PUT", "/api/settings", { values: { STORAGE_SOFT_LIMIT_GB: 1, RETENTION_DAYS: 365 } });
  const gl = [];
  for (const [day, gb] of [["2026-11-27", 0.5], ["2026-11-28", 1], ["2026-11-29", 1]]) {
    const n = day.replace(/-/g, "") + "-100000-interval.jpg";
    G.b2.put("shots/" + day + "/" + n, "x"); gl.push("shots/" + day + "/" + n + " " + Math.round(gb * 1e9) + " interval");
  }
  G.b2.put("keep/2026-11-01/big.jpg", "k");
  await G.req("POST", "/mac/index", { mac: true, body: gl.join("\n") });
  await G.env.DB.prepare("INSERT INTO files VALUES ('keep/2026-11-01/big.jpg','keep','2026-11-01','big.jpg',500000000,'',1)").run();
  out = await G.app.every15(G.env);
  // used 3.0 GB, limit 1 GB, target 0 GB of non-keep: all three days go, keep stays
  eq(out.guard, 3, "storage guard deletes the oldest non-keep days until under the limit");
  ok(G.b2.has("keep/2026-11-01/big.jpg"), "storage guard never touches keep/");
  const s = await (await G.api("GET", "/api/storage")).json();
  ok(s.guard && s.guard.deleted === 3, "the guard's last action is shown on the storage page");
}

console.log("== storage payload");
{
  const S = await setup({ t: Date.UTC(2026, 10, 15, 12) / 1000, count: true });
  await S.login();
  const lines = [];
  for (let d = 1; d <= 14; d++) {
    const day = "2026-11-" + String(d).padStart(2, "0");
    lines.push("shots/" + day + "/" + day.replace(/-/g, "") + "-100000-interval.jpg 100000000 interval");
  }
  await S.req("POST", "/mac/index", { mac: true, body: lines.join("\n") });
  await S.req("POST", "/mac/status", { mac: true, body: JSON.stringify({ updated: S.t, diskFreeGB: 12, queueMB: 4, queue: 7 }) });
  const s = await (await S.api("GET", "/api/storage")).json();
  eq([s.usedBytes, s.freeBytes, s.softLimitBytes], [1.4e9, 10e9, 8e9], "used vs the 10 GB free allowance, soft limit 8 GB");
  eq(s.level, "ok", "14 % used is green");
  eq([s.byKind.shots.files, s.byKind.keep.files], [14, 0], "breakdown by kind");
  eq(s.perDay.length, 14, "bytes per day for 14 days");
  eq(s.avgPerDay, 1e8, "average growth per day over the last 7 days");
  eq(s.daysUntilSoftLimit, 66, "days until the soft limit at that rate");
  eq(s.mac, { diskFreeGB: 12, queueMB: 4, queueFiles: 7, updated: S.t }, "Mac disk and queue from the latest status");
  ok(s.usage.estimated && s.usage.workerRequests > 0 && s.usage.workerLimit === 100000, "sampled request counter (estimate)");
  eq([Logic.meterLevel(0.69), Logic.meterLevel(0.7), Logic.meterLevel(0.9)], ["ok", "warn", "bad"], "meter amber at 70 %, red at 90 %");
}

console.log("== reconcile");
{
  const S = await setup();
  await S.login();
  S.b2.put("shots/2026-11-15/20261115-100000-space.jpg", "abc");        // in B2, not in D1
  S.b2.put("random/file.txt", "z");                                      // not ours: ignored
  await S.env.DB.prepare("INSERT INTO files VALUES ('shots/2026-11-14/gone.jpg','shots','2026-11-14','gone.jpg',9,'',1)").run();  // in D1, not in B2
  const r = await S.app.reconcile(S.env);
  eq([r.complete, r.added, r.removed], [true, 1, 1], "reconcile adds what B2 has and drops what it does not");
  const f = await (await S.api("GET", "/api/files?kind=shots&day=2026-11-15")).json();
  eq([f.files[0].bytes, f.files[0].reason], [3, "space"], "reconciled row has size and reason");
}

console.log("== headers, static pages, secrets");
{
  const S = await setup();
  let r = await S.req("GET", "/");
  eq(r.status, 200, "the page is served");
  for (const [k, v] of [["Content-Security-Policy", CSP], ["X-Content-Type-Options", "nosniff"], ["Referrer-Policy", "no-referrer"], ["X-Robots-Tag", "noindex, nofollow"]]) {
    eq(r.headers.get(k), v, k + " on pages");
  }
  ok(/frame-ancestors 'none'/.test(CSP) && /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client;/.test(CSP), "CSP: no framing, scripts only from here and Google sign-in");
  for (const p of ["/api/status", "/mac/poll", "/auth/config", "/health", "/nope.html"]) {
    r = await S.req("GET", p);
    eq(r.headers.get("Content-Security-Policy"), CSP, "CSP on " + p);
  }
  r = await S.req("GET", "/README.md");
  eq(r.status, 404, "README is not served (web/.assetsignore)");
  await S.login();
  await S.req("POST", "/mac/status", { mac: true, body: JSON.stringify({ updated: 1 }) });
  for (const p of ["/auth/config", "/api/status", "/api/storage", "/api/settings", "/api/days?kind=shots", "/api/live", "/health"]) await noSecret(await S.api("GET", p), p);
  await noSecret(await S.req("GET", "/mac/poll?paused=no", { mac: true }), "/mac/poll");
  await noSecret(await S.req("POST", "/auth/google", { json: { credential: "bad" } }), "refused sign-in");
  const all = await S.env.DB.prepare("SELECT k, v FROM kv").all();
  ok(!JSON.stringify(all.results).includes(SECRETS.B2_APP_KEY), "the B2 application key is never stored in D1");
}

console.log("== b2.js against a fake B2 API");
{
  const kvm = new Map();
  const kv = { get: async (k) => kvm.get(k) || null, set: async (k, v) => { kvm.set(k, v); } };
  const seen = [];
  let tokenGen = 0, expireNext = false;
  const fetchFn = async (url, init = {}) => {
    const h = new Headers(init.headers || {});
    seen.push({ url, auth: h.get("Authorization"), body: init.body });
    if (url.endsWith("/b2_authorize_account")) {
      if (h.get("Authorization") !== "Basic " + btoa(SECRETS.B2_KEY_ID + ":" + SECRETS.B2_APP_KEY)) return new Response("{}", { status: 401 });
      tokenGen++;
      return Response.json({ accountId: "acc", authorizationToken: "tok" + tokenGen,
        apiInfo: { storageApi: { apiUrl: "https://api.fake", downloadUrl: "https://dl.fake", allowed: { buckets: [{ id: "bucket-id", name: SECRETS.B2_BUCKET }] } } } });
    }
    if (expireNext) { expireNext = false; return Response.json({ code: "expired_auth_token" }, { status: 401 }); }
    if (url === "https://api.fake/b2api/v3/b2_list_file_names") {
      const b = JSON.parse(init.body);
      return Response.json({ files: [{ action: "upload", fileName: b.prefix + "a.jpg", fileId: "f1", contentLength: 5, uploadTimestamp: 1 }, { action: "hide", fileName: b.prefix + "b.jpg", fileId: "f2" }], nextFileName: null });
    }
    if (url === "https://api.fake/b2api/v3/b2_delete_file_version") return Response.json({});
    if (url.startsWith("https://dl.fake/file/")) return new Response("BYTES", { status: 200 });
    return new Response("{}", { status: 400 });
  };
  const budget = { left: 10 };
  const c = makeB2(SECRETS, { fetchFn, kv, now: () => 1000, budget });
  const l = await c.list("shots/2026-11-15/", null, 10);
  eq(l.files, [{ name: "shots/2026-11-15/a.jpg", id: "f1", size: 5, ts: 1 }], "list returns uploads only (hide markers skipped)");
  ok(JSON.parse(seen[1].body).bucketId === "bucket-id", "bucket id from the restricted key");
  ok(kvm.has("b2_auth") && !kvm.get("b2_auth").includes(SECRETS.B2_APP_KEY), "authorization cached in D1 (token only, never the key)");
  const c2 = makeB2(SECRETS, { fetchFn, kv, now: () => 2000, budget });
  await c2.list("x/", null, 1);
  eq(tokenGen, 1, "a second invocation reuses the cached authorization (no class C call)");
  expireNext = true;
  await c2.remove("x/a.jpg", "f1");
  eq(tokenGen, 2, "an expired token is refreshed once and the call retried");
  const d = await c2.download("shots/2026-11-15/a b.jpg");
  eq(await d.text(), "BYTES", "download streams the object");
  ok(seen[seen.length - 1].url === "https://dl.fake/file/macwatch-test/shots/2026-11-15/a%20b.jpg", "download URL is encoded per path segment");
  const tiny = makeB2(SECRETS, { fetchFn, kv, now: () => 2000, budget: { left: 0 } });
  let threw = false;
  try { await tiny.list("x/"); } catch (e) { threw = e.constructor.name === "BudgetError"; }
  ok(threw, "the subrequest budget is enforced");
  const badKey = makeB2(Object.assign({}, SECRETS, { B2_APP_KEY: "wrong", B2_KEY_ID: "other" }), { fetchFn, kv, now: () => 2000, budget: { left: 5 } });
  try { await badKey.list("x/"); ok(false, "wrong key refused"); } catch (e) { ok(/authorize failed: HTTP 401/.test(e.message) && !e.message.includes("wrong"), "wrong key refused without echoing it"); }
}

console.log("\n" + passes + " passed, " + fails + " failed");
process.exit(fails ? 1 : 0);
