// Tests for the web dashboard's logic and its Drive client (against an in-memory fake Drive).
// Run by tests/run.sh when node is installed:  node tests/web_test.js
"use strict";
const { execFileSync } = require("child_process");
const path = require("path");
const L = require("../web/logic.js");
const D = require("../web/drive.js");
const ROOT = path.join(__dirname, "..");

let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; console.log("  ok   " + msg); } else { fails++; console.log("  FAIL " + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + (JSON.stringify(a) === JSON.stringify(b) ? "" : "  got " + JSON.stringify(a))); }

// ---- the settings table must match bin/lib.sh (remote_bounds) -------------------------
const sh = (script) => execFileSync("sh", ["-c", script], { env: Object.assign({}, process.env, { MW_BIN: path.join(ROOT, "bin") }), encoding: "utf8" }).trim();
const shellKeys = sh('. "$MW_BIN/lib.sh"; remote_keys').split(/\s+/).sort();
eq(L.SETTINGS.map((s) => s.key).sort(), shellKeys, "web settings keys == shell whitelist");
L.SETTINGS.forEach((s) => {
  const b = sh('. "$MW_BIN/lib.sh"; remote_bounds ' + s.key);
  eq(b, s.min + " " + s.max, "bounds of " + s.key + " match the shell");
});

// ---- page wiring: every id the script touches exists in index.html ------------------------
const fs = require("fs");
const html = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "web/app.js"), "utf8");
const used = new Set(); let mm; const re = /\$\("([a-z-]+)"\)/g;
while ((mm = re.exec(app))) used.add(mm[1]);
const dynamic = /\$\("set-"/.test(app);   // settings inputs are created by buildSettingsForm
const missing = [...used].filter((id) => html.indexOf('id="' + id + '"') < 0);
eq(missing, [], "every $(id) used by app.js exists in index.html (" + used.size + " ids)");
ok(dynamic, "settings inputs are built dynamically");
ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(app), "app.js never injects HTML (Drive text is shown with textContent only)");
ok(/script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client/.test(fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8")), "CSP limits scripts to this site and Google sign-in");
ok(!/client_secret|GOCSPX|refresh_token/i.test(app + fs.readFileSync(path.join(ROOT, "web/config.js"), "utf8") + html), "no secrets in the web files");

// ---- logic ------------------------------------------------------------------------------
eq(L.parseConfig("# x\nINTERVAL_SEC=120\nJPEG_QUALITY=5\nEVIL=1\nKEEP_AWAKE=1\nRETENTION_DAYS=abc\n"), { INTERVAL_SEC: 120, KEEP_AWAKE: 1 }, "parseConfig keeps only valid whitelisted numbers");
let b = L.buildConfig({ INTERVAL_SEC: "120", JPEG_QUALITY: "" , KEEP_AWAKE: "1", RECORD_SEC: "2000" });
ok(/INTERVAL_SEC=120\n/.test(b.text) && /KEEP_AWAKE=1\n/.test(b.text) && !/JPEG/.test(b.text), "buildConfig writes only filled values");
ok(b.errors.length === 1 && /RECORD_SEC/.test(b.errors[0]), "buildConfig reports out-of-range values");
b = L.buildConfig({ INTERVAL_SEC: "1.5" }); ok(b.errors.length === 1, "non-integers refused");
b = L.buildConfig({ INTERVAL_SEC: "$(touch x)" }); ok(b.errors.length === 1 && b.text.indexOf("$(") < 0, "text can never reach the config");
eq(L.statusHealth(1000, 1100).level, "ok", "fresh status is ok");
eq(L.statusHealth(1000, 1000 + 12 * 60).level, "warn", "12 min old is a warning");
eq(L.statusHealth(1000, 1000 + 30 * 60).level, "bad", "30 min old is bad");
eq(L.statusHealth(0, 5).level, "bad", "no status is bad");
eq(L.parseShotName("20261113-152800-space.jpg"), { date: "2026-11-13", time: "15:28:00", reason: "space" }, "shot name parsed");
eq(L.parseShotName("20261113-152800-space-2.jpg").reason, "space", "collision suffix ignored");
eq(L.parseShotName("20261113-153100-rec.mov").reason, "rec", "recording name parsed");
eq(L.parseShotName("junk.jpg"), { date: "", time: "", reason: "" }, "junk name tolerated");
eq([L.ageString(5), L.ageString(300), L.ageString(7200), L.ageString(400000)], ["5 s", "5 min", "2 h", "5 days"], "ageString");

// ---- fake Google Drive ----------------------------------------------------------------
function fakeDrive() {
  let n = 0;
  const files = new Map();               // id -> {id,name,mimeType,parents,body}
  const calls = [];
  const mk = (name, mimeType, parents, body) => { const id = "id" + (++n); files.set(id, { id, name, mimeType, parents, body: body || "" }); return files.get(id); };
  const unq = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  function matches(f, query) {
    return query.split(" and ").every((t) => {
      let m;
      if ((m = /^'(.*)' in parents$/.exec(t))) return f.parents.includes(unq(m[1]));
      if (t === "trashed = false") return true;
      if ((m = /^name = '(.*)'$/.exec(t))) return f.name === unq(m[1]);
      if ((m = /^mimeType = '(.*)'$/.exec(t))) return f.mimeType === m[1];
      if ((m = /^mimeType != '(.*)'$/.exec(t))) return f.mimeType !== m[1];
      throw new Error("fake Drive does not understand query term: " + t);
    });
  }
  async function fetch(url, init) {
    init = init || {};
    calls.push({ url, method: init.method || "GET" });
    const h = init.headers || {};
    if (h.Authorization !== "Bearer TOKEN") return { status: 401, ok: false, text: async () => "unauth" };
    const u = new URL(url);
    const p = u.pathname, method = init.method || "GET";
    const res = (obj) => ({ status: 200, ok: true, json: async () => obj, text: async () => (typeof obj === "string" ? obj : JSON.stringify(obj)), blob: async () => ({ size: String(obj).length }) });
    let m;
    if (p === "/drive/v3/files" && method === "GET") {
      let query = u.searchParams.get("q");
      query = query.replace(/^'root' in parents/, "'root' in parents");
      let r = [...files.values()].filter((f) => matches(f, query));
      if (u.searchParams.get("orderBy") === "name desc") r.sort((a, b) => (a.name < b.name ? 1 : -1));
      r = r.slice(0, Number(u.searchParams.get("pageSize") || 100));
      return res({ files: r.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.body.length) })) });
    }
    if (p === "/drive/v3/files" && method === "POST") { const b = JSON.parse(init.body); const f = mk(b.name, b.mimeType, b.parents); return res({ id: f.id, name: f.name }); }
    if ((m = /^\/drive\/v3\/files\/(\w+)$/.exec(p))) {
      const f = files.get(m[1]);
      if (!f) return { status: 404, ok: false, text: async () => "nf" };
      if (method === "GET" && u.searchParams.get("alt") === "media") return res(f.body);
      if (method === "DELETE") { files.delete(f.id); return res({}); }
      if (method === "PATCH") {
        f.parents = f.parents.filter((x) => x !== u.searchParams.get("removeParents")).concat([u.searchParams.get("addParents")]);
        return res({ id: f.id });
      }
    }
    if (p === "/upload/drive/v3/files" && method === "POST") {
      const bnd = /boundary=(\S+)/.exec(h["Content-Type"])[1];
      const parts = init.body.split("--" + bnd).filter((x) => x.trim() && x.trim() !== "--");
      const meta = JSON.parse(parts[0].split("\r\n\r\n")[1].trim());
      const body = parts[1].split("\r\n\r\n")[1].replace(/\r\n$/, "");
      const f = mk(meta.name, "text/plain", meta.parents, body);
      return res({ id: f.id });
    }
    if ((m = /^\/upload\/drive\/v3\/files\/(\w+)$/.exec(p)) && method === "PATCH") { files.get(m[1]).body = init.body; return res({ id: m[1] }); }
    throw new Error("fake Drive: unhandled " + method + " " + url);
  }
  return { fetch, files, calls, mk };
}

(async () => {
  const fd = fakeDrive();
  let token = "TOKEN";
  const drive = D.createDrive({ fetch: fd.fetch, getToken: () => token });

  const control = await drive.folderId("mac-watch/control", true);
  ok(!!control, "folderId creates mac-watch/control");
  const again = await drive.folderId("mac-watch/control", true);
  eq(again, control, "folderId is stable");
  const before = fd.calls.length; await drive.folderId("mac-watch/control", true);
  eq(fd.calls.length, before, "folder ids are cached (no extra calls)");
  eq(await drive.folderId("mac-watch/nothere", false), null, "missing folder without create gives null");

  await drive.writeText(control, "config.remote", "INTERVAL_SEC=120\n");
  const cfgFile = await drive.findChild(control, "config.remote");
  eq(await drive.readText(cfgFile.id), "INTERVAL_SEC=120\n", "write then read config.remote (multipart create)");
  await drive.writeText(control, "config.remote", "INTERVAL_SEC=60\n");
  eq([...fd.files.values()].filter((f) => f.name === "config.remote").length, 1, "second write updates in place");
  eq(await drive.readText(cfgFile.id), "INTERVAL_SEC=60\n", "updated content");

  await drive.createFolder(control, "snap-now");
  const marker = await drive.findChild(control, "snap-now", D.FOLDER);
  ok(marker && marker.name === "snap-now", "marker folder created inside control/");
  eq(await drive.findChild(control, "it's \\ tricky"), null, "quotes and backslashes in names are escaped (no crash)");

  const shots = await drive.folderId("mac-watch/shots/2026-11-13", true);
  const shot = fd.mk("20261113-152800-space.jpg", "image/jpeg", [shots], "JPEGDATA");
  fd.mk("20261113-152900-remote.jpg", "image/jpeg", [shots], "JPEGDATA2");
  const l = await drive.list(shots, "mimeType != '" + D.FOLDER + "'", { orderBy: "name desc" });
  eq(l.map((f) => f.name), ["20261113-152900-remote.jpg", "20261113-152800-space.jpg"], "list returns newest first");
  const keep = await drive.folderId("mac-watch/keep/2026-11-13", true);
  await drive.move(shot.id, shots, keep);
  eq(fd.files.get(shot.id).parents, [keep], "move changes the parent folder");
  await drive.remove(cfgFile.id);
  eq(await drive.findChild(control, "config.remote"), null, "remove deletes the file");

  token = "EXPIRED";
  let err = null; try { await drive.list(control); } catch (e) { err = e; }
  ok(err && err.code === 401, "expired token is reported as code 401 (page shows sign-in again)");

  console.log("\n" + passes + " web checks passed, " + fails + " failed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log("  FAIL exception: " + e.stack); process.exit(1); });
