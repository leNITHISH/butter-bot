// mac-watch Worker: all request handling, written against small interfaces so node can test it.
//   env.DB      a D1 database (tests: a node:sqlite shim with the same API)
//   env.ASSETS  static files from web/ (tests: a fake that reads the folder)
//   deps.b2     (env, ctx) -> B2 client (worker/b2.js; tests: an in-memory fake)
//   deps.now    () -> unix seconds
//   deps.random () -> [0,1)
//   deps.googleKeys (force) -> Google's JWKS keys array
// Secrets (wrangler secret put): SESSION_SECRET, MAC_TOKEN_HASH, ALLOWED_EMAIL, B2_KEY_ID,
// B2_APP_KEY, B2_BUCKET, GOOGLE_CLIENT_ID. None of them is ever put into a response or a log.
import Logic from "../web/logic.js";
import { BudgetError } from "./b2.js";

const enc = new TextEncoder();
const SESSION_DAYS = 14;
const WATCH_SEC = 600;
const FREE_BYTES = 10e9;            // Backblaze B2 free storage (10 GB)
const WORKER_REQ_LIMIT = 100000;    // Workers free plan, per day
const B2_DOWNLOAD_LIMIT = 2500;     // B2 class B free calls per day
const SUBREQ_BUDGET = 40;           // free plan: 50 outgoing requests per invocation; keep a margin
const KINDS = ["shots", "thumbs", "recordings", "keep", "live"];
const PURGEABLE = ["shots", "thumbs", "recordings"];

export const CSP = "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; " +
  "connect-src 'self' https://accounts.google.com; img-src 'self' blob: data:; media-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com/gsi/; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // Google's sign-in popup needs to talk back to this page
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups"
};

// ------------------------------------------------------------------ helpers --

function withSecurity(res, extra) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, extra || {})
  });
}
function text(body, status) {
  return new Response(body, { status: status || 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
const err = (status, msg) => json({ error: msg }, status);
const bare = (status) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });

function b64url(bytes) {
  let s = "";
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
export async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
// Constant time for equal-length inputs; different lengths are simply unequal.
export function ctEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function utcDay(epoch) { return new Date(epoch * 1000).toISOString().slice(0, 10); }
function reasonOf(name) { return Logic.parseShotName(name).reason || ""; }
async function readText(request, max) {
  const t = await request.text();
  if (t.length > max) throw Object.assign(new Error("too large"), { status: 413 });
  return t;
}
async function readJson(request, max) {
  try { return JSON.parse(await readText(request, max || 65536)); } catch (e) { return undefined; }
}

// ---------------------------------------------------------------------- kv --

function kvStore(db, now) {
  return {
    async get(k) { const r = await db.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first(); return r ? r.v : null; },
    async getMany(keys) {
      const r = await db.prepare("SELECT k, v FROM kv WHERE k IN (" + keys.map(() => "?").join(",") + ")").bind(...keys).all();
      const out = {};
      for (const row of r.results || []) out[row.k] = row.v;
      return out;
    },
    async set(k, v) {
      await db.prepare("INSERT INTO kv (k, v, updated) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated")
        .bind(k, String(v), now()).run();
    }
  };
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function parseJson(v, dflt) { try { return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }

// ------------------------------------------------------------------- auth --

let googleKeyCache = { keys: null, exp: 0 };
export async function fetchGoogleKeys(force, now) {
  if (!force && googleKeyCache.keys && googleKeyCache.exp > now) return googleKeyCache.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new Error("google certs: HTTP " + res.status);
  const j = await res.json();
  const m = /max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "");
  googleKeyCache = { keys: j.keys || [], exp: now + Math.min(m ? Number(m[1]) : 3600, 86400) };
  return googleKeyCache.keys;
}

// Verifies a Google ID token (JWT, RS256) entirely here. Returns the e-mail or throws.
export async function verifyGoogleToken(token, { clientId, allowedEmail, now, googleKeys }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || token.length > 8192) throw new Error("malformed token");
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch (e) { throw new Error("malformed token"); }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("bad alg");
  let keys = await googleKeys(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await googleKeys(true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error("unknown key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!good) throw new Error("bad signature");
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") throw new Error("bad issuer");
  if (!clientId || payload.aud !== clientId) throw new Error("bad audience");
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("expired");
  if (typeof payload.iat === "number" && payload.iat > now + 300) throw new Error("issued in the future");
  if (payload.email_verified !== true && payload.email_verified !== "true") throw new Error("email not verified");
  const email = String(payload.email || "").toLowerCase();
  if (!allowedEmail || !ctEqual(email, String(allowedEmail).trim().toLowerCase())) throw new Error("email not allowed");
  return email;
}

const COOKIE = "__Host-mw";

async function makeSession(env, epoch, now) {
  const payload = b64url(enc.encode(JSON.stringify({ v: 1, ep: epoch, exp: now + SESSION_DAYS * 86400 })));
  return payload + "." + await hmac(env.SESSION_SECRET, payload);
}
async function checkSession(request, env, kv, now) {
  if (!env.SESSION_SECRET) return false;
  const m = new RegExp("(?:^|;\\s*)" + COOKIE + "=([A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)").exec(request.headers.get("Cookie") || "");
  if (!m) return false;
  const [p, sig] = m[1].split(".");
  if (!ctEqual(sig, await hmac(env.SESSION_SECRET, p))) return false;
  let d;
  try { d = JSON.parse(new TextDecoder().decode(b64urlDecode(p))); } catch (e) { return false; }
  if (!d || typeof d.exp !== "number" || d.exp <= now) return false;
  const epoch = num(await kv.get("session_epoch"));
  return d.ep === epoch;
}
function cookieHeader(value, maxAge) {
  return COOKIE + "=" + value + "; Path=/; Max-Age=" + maxAge + "; HttpOnly; Secure; SameSite=Strict";
}

async function checkMac(request, env) {
  const m = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.get("Authorization") || "");
  if (!m || !env.MAC_TOKEN_HASH) return false;
  return ctEqual(await sha256hex(m[1]), String(env.MAC_TOKEN_HASH).trim().toLowerCase());
}

// State-changing browser requests: our own header (a cross-site form cannot set it), a JSON
// body, and, when the browser sends one, an Origin equal to ours.
function csrfOk(request, url) {
  if (request.headers.get("X-MW") !== "1") return false;
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return false;
  const o = request.headers.get("Origin");
  return !o || o === url.origin;
}

// ------------------------------------------------------------------ files --

async function upsertFiles(db, rows) {
  const stmts = rows.map((r) => db.prepare(
    "INSERT INTO files (key, kind, day, name, bytes, reason, uploaded) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET bytes = excluded.bytes, reason = excluded.reason"
  ).bind(r.key, r.kind, r.day, r.name, r.bytes, r.reason, r.uploaded));
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}
async function deleteRows(db, keys) {
  const stmts = keys.map((k) => db.prepare("DELETE FROM files WHERE key = ?").bind(k));
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

// Deletes the given D1 rows from B2 (and then from D1), oldest first, within the budget.
// One list call per folder finds the file ids; each delete is one more call.
export async function purgeRows(db, b2, rows, budget) {
  const groups = new Map();
  for (const r of rows) {
    const dir = r.key.slice(0, r.key.lastIndexOf("/") + 1);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(r);
  }
  let deleted = 0, bytes = 0, stopped = false;
  const gone = [];
  try {
    for (const [dir, list] of groups) {
      list.sort((a, b) => (a.key < b.key ? -1 : 1));
      if (budget.left < 2) { stopped = true; break; }
      const ids = new Map();
      let start = list[0].key, next = null;
      // page through the folder only as far as we need
      do {
        if (budget.left < 2) break;
        const page = await b2.list(dir, start, 1000);
        for (const f of page.files) ids.set(f.name, f.id);
        next = page.next;
        start = next;
      } while (next && next <= list[list.length - 1].key);
      for (const r of list) {
        if (ids.has(r.key)) {
          if (budget.left < 1) { stopped = true; break; }
          await b2.remove(r.key, ids.get(r.key));
        } else if (next && r.key >= next) {
          stopped = true; continue;         // not listed yet: do not assume it is gone
        }
        gone.push(r.key);                    // deleted now, or already gone from B2
        deleted++; bytes += num(r.bytes);
      }
      if (stopped) break;
    }
  } catch (e) {
    if (!(e instanceof BudgetError)) { await deleteRows(db, gone); throw e; }
    stopped = true;
  }
  await deleteRows(db, gone);
  return { deleted, bytes, stopped };
}

async function storageTotals(db) {
  const r = await db.prepare("SELECT kind, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM files GROUP BY kind").all();
  const byKind = {};
  for (const k of KINDS) byKind[k] = { files: 0, bytes: 0 };
  let used = 0;
  for (const row of r.results || []) {
    byKind[row.kind] = { files: num(row.n), bytes: num(row.b) };
    used += num(row.b);
  }
  return { used, byKind };
}

// ------------------------------------------------------------- the app ------

export function makeApp(deps) {
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  const random = deps.random || Math.random;
  const googleKeys = deps.googleKeys || ((force) => fetchGoogleKeys(force, now()));

  async function count(env, ctx, field) {
    if (random() >= 0.1) return;
    const p = env.DB.prepare("INSERT INTO usage (day, " + field + ") VALUES (?, 10) ON CONFLICT(day) DO UPDATE SET " + field + " = " + field + " + 10")
      .bind(utcDay(now())).run().catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
  }

  async function settingsOf(kv) { return parseJson(await kv.get("settings"), {}); }

  // ----------------------------------------------------------- Mac routes --
  async function macRoute(request, env, url, kv, ctx) {
    if (!await checkMac(request, env)) return bare(401);
    const t = now();
    const path = url.pathname;

    if (path === "/mac/poll" && request.method === "GET") {
      const paused = url.searchParams.get("paused");
      const pz = paused === "remote" || paused === "local" ? paused : "no";
      const v = await kv.getMany(["mac", "watching_until", "live_until", "settings"]);
      const mac = parseJson(v.mac, {});
      if (t - num(mac.seen) >= 60 || mac.paused !== pz) await kv.set("mac", JSON.stringify({ seen: t, paused: pz }));
      const lines = [];
      lines.push("fast " + (num(v.watching_until) > t ? 1 : 0));
      lines.push("live " + (num(v.live_until) > t ? 1 : 0));
      const cmds = await env.DB.prepare("SELECT id, name, created FROM commands WHERE acked IS NULL ORDER BY id LIMIT 20").all();
      for (const c of cmds.results || []) lines.push("cmd " + c.id + " " + c.name + " " + c.created);
      const s = parseJson(v.settings, {});
      for (const k of Logic.macKeys()) if (Object.prototype.hasOwnProperty.call(s, k)) lines.push("set " + k + "=" + s[k]);
      return text(lines.join("\n") + "\n");
    }
    if (request.method !== "POST") return bare(405);

    if (path === "/mac/ack") {
      const id = (await readText(request, 64)).trim();
      if (!/^\d{1,12}$/.test(id)) return bare(400);
      await env.DB.prepare("UPDATE commands SET acked = ? WHERE id = ? AND acked IS NULL").bind(t, Number(id)).run();
      return bare(204);
    }
    if (path === "/mac/status") {
      const body = await readText(request, 16384);
      let d;
      try { d = JSON.parse(body); } catch (e) { return bare(400); }
      if (!d || typeof d !== "object" || Array.isArray(d)) return bare(400);
      await kv.set("status_json", JSON.stringify(d));
      return bare(204);
    }
    if (path === "/mac/index") {
      const body = await readText(request, 1 << 20);
      const rows = [];
      let rejected = 0;
      for (const line of body.split("\n")) {
        if (!line.trim()) continue;
        const [key, bytes, reason] = line.trim().split(/\s+/);
        const p = Logic.parseKey(key);
        if (!p || p.kind === "keep" || p.kind === "live" || !/^\d{1,12}$/.test(bytes || "")) { rejected++; continue; }
        const r = /^[a-z0-9-]{1,24}$/.test(reason || "") ? reason : reasonOf(p.name);
        rows.push({ key, kind: p.kind, day: p.day, name: p.name, bytes: Number(bytes), reason: r, uploaded: t });
        if (rows.length > 5000) return bare(413);
      }
      await upsertFiles(env.DB, rows);
      return text("indexed " + rows.length + " rejected " + rejected + "\n");
    }
    if (path === "/mac/live") {
      const [key, bytes] = (await readText(request, 512)).trim().split(/\s+/);
      const p = Logic.parseKey(key);
      if (!p || p.kind !== "live") return bare(400);
      const b = /^\d{1,9}$/.test(bytes || "") ? Number(bytes) : 0;
      await kv.set("live_key", JSON.stringify({ key, taken: t }));
      await upsertFiles(env.DB, [{ key, kind: "live", day: "", name: p.name, bytes: b, reason: "live", uploaded: t }]);
      return bare(204);
    }
    return bare(404);
  }

  // ------------------------------------------------------------ page API --
  async function apiRoute(request, env, url, kv, ctx) {
    const t = now();
    const path = url.pathname;
    const m = request.method;
    if (m !== "GET" && m !== "HEAD" && !csrfOk(request, url)) return err(403, "forbidden");

    if (path === "/api/status" && m === "GET") {
      const v = await kv.getMany(["status_json", "mac", "watching_until", "live_until"]);
      const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM commands WHERE acked IS NULL").first();
      const mac = parseJson(v.mac, {});
      return json({
        now: t, status: parseJson(v.status_json, null), lastSeen: num(mac.seen) || 0, macPaused: mac.paused || "",
        watching: num(v.watching_until) > t, live: num(v.live_until) > t, liveUntil: num(v.live_until),
        pendingCommands: num(pending && pending.n)
      });
    }
    if (path === "/api/watching" && m === "POST") {
      const v = await kv.getMany(["live_until"]);
      await kv.set("watching_until", t + WATCH_SEC);
      if (num(v.live_until) > t) await kv.set("live_until", t + WATCH_SEC);   // live stops 10 min after the page closes
      return json({ ok: true, until: t + WATCH_SEC });
    }
    if (path === "/api/command" && m === "POST") {
      const b = await readJson(request);
      const name = b && b.name;
      if (Logic.COMMANDS.indexOf(name) < 0) return err(400, "unknown command");
      if (name === "live-on") {
        await kv.set("live_until", t + WATCH_SEC);
        await kv.set("watching_until", t + WATCH_SEC);
        return json({ ok: true });
      }
      if (name === "live-off") { await kv.set("live_until", 0); return json({ ok: true }); }
      // a double tap within 10 s is one command
      const dup = await env.DB.prepare("SELECT id FROM commands WHERE name = ? AND acked IS NULL AND created >= ?").bind(name, t - 10).first();
      if (dup) return json({ ok: true, id: dup.id, duplicate: true });
      const r = await env.DB.prepare("INSERT INTO commands (name, created) VALUES (?, ?) RETURNING id").bind(name, t).first();
      await kv.set("watching_until", t + WATCH_SEC);     // the reply should arrive fast
      return json({ ok: true, id: r.id });
    }
    if (path === "/api/settings") {
      if (m === "GET") {
        return json({ values: await settingsOf(kv), table: Logic.SETTINGS });
      }
      if (m === "PUT") {
        const b = await readJson(request);
        const res = Logic.validateSettings(b && b.values);
        if (res.errors.length) return json({ error: "invalid settings", errors: res.errors }, 400);
        await kv.set("settings", JSON.stringify(res.values));
        return json({ ok: true, values: res.values });
      }
    }
    if (path === "/api/days" && m === "GET") {
      const kind = url.searchParams.get("kind");
      if (["shots", "recordings", "keep"].indexOf(kind) < 0) return err(400, "bad kind");
      const r = await env.DB.prepare("SELECT day, COUNT(*) AS files, SUM(bytes) AS bytes FROM files WHERE kind = ? GROUP BY day ORDER BY day DESC LIMIT 400").bind(kind).all();
      return json({ kind, days: (r.results || []).map((x) => ({ day: x.day, files: num(x.files), bytes: num(x.bytes) })) });
    }
    if (path === "/api/files" && m === "GET") {
      const kind = url.searchParams.get("kind");
      const day = url.searchParams.get("day") || "";
      const after = url.searchParams.get("after") || "";
      const limit = Math.min(Math.max(num(url.searchParams.get("limit")) || 60, 1), 200);
      if (["shots", "recordings", "keep"].indexOf(kind) < 0) return err(400, "bad kind");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return err(400, "bad day");
      if (after && !/^[A-Za-z0-9._-]{1,120}$/.test(after)) return err(400, "bad cursor");
      const r = await env.DB.prepare(
        "SELECT f.key, f.name, f.bytes, f.reason, f.uploaded, t.key AS thumb FROM files f " +
        "LEFT JOIN files t ON t.key = 'thumbs/' || f.day || '/' || f.name " +
        "WHERE f.kind = ? AND f.day = ? AND (? = '' OR f.name < ?) ORDER BY f.name DESC LIMIT ?"
      ).bind(kind, day, after, after, limit + 1).all();
      const rows = r.results || [];
      const more = rows.length > limit;
      const files = rows.slice(0, limit).map((x) => ({
        key: x.key, name: x.name, bytes: num(x.bytes), reason: x.reason, uploaded: num(x.uploaded), thumb: x.thumb || null
      }));
      return json({ kind, day, files, next: more ? files[files.length - 1].name : null });
    }
    if (path === "/api/live" && m === "GET") {
      const v = parseJson(await kv.get("live_key"), null);
      return json(v || { key: null, taken: 0 });
    }
    if (path === "/api/storage" && m === "GET") {
      return json(await storagePayload(env, kv));
    }
    if (path === "/api/keep" && m === "POST") {
      const b = await readJson(request);
      const keys = b && Array.isArray(b.keys) ? b.keys : null;
      if (!keys || !keys.length || keys.length > 10) return err(400, "send 1 to 10 keys");
      for (const k of keys) {
        const p = Logic.parseKey(k);
        if (!p || (p.kind !== "shots" && p.kind !== "recordings")) return err(400, "bad key");
      }
      const budget = { left: SUBREQ_BUDGET };
      const b2 = deps.b2(env, { kv, budget, now });
      const kept = [], failed = [];
      for (const k of keys) {
        const p = Logic.parseKey(k);
        const dst = "keep/" + p.day + "/" + p.name;
        try {
          const found = (await b2.list(k, k, 1)).files.find((f) => f.name === k);
          if (!found) { failed.push({ key: k, error: "not found" }); continue; }
          const c = await b2.copy(found.id, dst);
          await b2.remove(k, found.id);
          const row = await env.DB.prepare("SELECT reason FROM files WHERE key = ?").bind(k).first();
          await upsertFiles(env.DB, [{ key: dst, kind: "keep", day: p.day, name: p.name, bytes: num(c.size || found.size),
                                       reason: (row && row.reason) || reasonOf(p.name), uploaded: t }]);
          await deleteRows(env.DB, [k]);
          kept.push(dst);
        } catch (e) {
          failed.push({ key: k, error: e instanceof BudgetError ? "try again" : "failed" });
          if (e instanceof BudgetError) break;
        }
      }
      return json({ kept, failed });
    }
    if (path === "/api/purge" && m === "POST") {
      return purgeApi(request, env, kv, t);
    }
    return err(404, "not found");
  }

  async function purgeApi(request, env, kv, t) {
    const b = await readJson(request);
    if (!b || typeof b !== "object") return err(400, "bad request");
    let where, args;
    if (b.mode === "keys") {
      if (!Array.isArray(b.keys) || !b.keys.length || b.keys.length > 200) return err(400, "send 1 to 200 keys");
      const keys = [];
      for (const k of b.keys) {
        const p = Logic.parseKey(k);
        if (!p || p.kind === "live") return err(400, "bad key");
        keys.push(k);
        if (p.kind === "shots") keys.push("thumbs/" + p.day + "/" + p.name);    // its thumbnail goes too
      }
      where = "key IN (" + keys.map(() => "?").join(",") + ")"; args = keys;
    } else {
      let kinds = b.kinds === undefined ? PURGEABLE : b.kinds;
      if (!Array.isArray(kinds) || !kinds.length || kinds.some((k) => PURGEABLE.indexOf(k) < 0)) return err(400, "bad kinds");
      if (kinds.indexOf("shots") >= 0 && kinds.indexOf("thumbs") < 0) kinds = kinds.concat(["thumbs"]);
      const kq = "kind IN (" + kinds.map(() => "?").join(",") + ")";
      if (b.mode === "day") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.day))) return err(400, "bad day");
        where = kq + " AND day = ?"; args = kinds.concat([b.day]);
      } else if (b.mode === "olderThanDays") {
        const d = Number(b.days);
        if (!Number.isInteger(d) || d < 1 || d > 3650) return err(400, "bad days");
        where = kq + " AND day < ?"; args = kinds.concat([utcDay(t - d * 86400)]);
      } else {
        return err(400, "bad mode");
      }
    }
    const total = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM files WHERE " + where).bind(...args).first();
    if (b.dryRun !== false) return json({ dryRun: true, files: num(total.n), bytes: num(total.b) });
    const rows = (await env.DB.prepare("SELECT key, bytes FROM files WHERE " + where + " ORDER BY day, key LIMIT 200").bind(...args).all()).results || [];
    const budget = { left: SUBREQ_BUDGET };
    const b2 = deps.b2(env, { kv, budget, now });
    let r;
    try { r = await purgeRows(env.DB, b2, rows, budget); } catch (e) { return err(502, "storage error, try again"); }
    return json({ dryRun: false, deleted: r.deleted, bytes: r.bytes, more: num(total.n) - r.deleted > 0 });
  }

  async function storagePayload(env, kv) {
    const t = now();
    const { used, byKind } = await storageTotals(env.DB);
    const settings = await settingsOf(kv);
    const soft = Logic.effective(settings, "STORAGE_SOFT_LIMIT_GB") * 1e9;
    const since = utcDay(t - 13 * 86400);
    const r = await env.DB.prepare("SELECT day, SUM(bytes) AS b FROM files WHERE kind IN ('shots','thumbs','recordings','keep') AND day >= ? GROUP BY day ORDER BY day").bind(since).all();
    const per = new Map((r.results || []).map((x) => [x.day, num(x.b)]));
    const perDay = [];
    for (let i = 13; i >= 0; i--) { const d = utcDay(t - i * 86400); perDay.push({ day: d, bytes: per.get(d) || 0 }); }
    // average growth over the last 7 complete days (today is still filling up)
    const last7 = perDay.slice(6, 13);
    const avg = last7.reduce((s, x) => s + x.bytes, 0) / 7;
    const v = await kv.getMany(["status_json", "reconcile_last", "guard_last"]);
    const st = parseJson(v.status_json, {}) || {};
    const u = await env.DB.prepare("SELECT worker_requests, b2_downloads FROM usage WHERE day = ?").bind(utcDay(t)).first();
    return {
      now: t,
      usedBytes: used, freeBytes: FREE_BYTES, softLimitBytes: soft,
      fraction: used / FREE_BYTES, level: Logic.meterLevel(used / FREE_BYTES),
      byKind, perDay, avgPerDay: Math.round(avg),
      daysUntilSoftLimit: avg > 0 ? Math.max(0, Math.floor((soft - used) / avg)) : null,
      mac: { diskFreeGB: st.diskFreeGB === undefined ? null : st.diskFreeGB, queueMB: st.queueMB === undefined ? null : st.queueMB,
             queueFiles: st.queue === undefined ? null : st.queue, updated: st.updated || 0 },
      usage: { estimated: true, workerRequests: num(u && u.worker_requests), workerLimit: WORKER_REQ_LIMIT,
               b2Downloads: num(u && u.b2_downloads), b2DownloadLimit: B2_DOWNLOAD_LIMIT },
      reconcile: parseJson(v.reconcile_last, null), guard: parseJson(v.guard_last, null)
    };
  }

  // --------------------------------------------------------- object bytes --
  async function objectRoute(request, env, url, kv, ctx, attachment) {
    let key;
    try { key = decodeURIComponent(url.pathname.slice(attachment ? 4 : 5)); } catch (e) { return err(400, "bad key"); }
    const p = Logic.parseKey(key);
    if (!p) return err(404, "not found");
    await count(env, ctx, "b2_downloads");
    const b2 = deps.b2(env, { kv, budget: { left: 5 }, now });
    let res;
    try { res = await b2.download(key, request.headers.get("Range")); } catch (e) { return err(502, "storage error"); }
    if (res.status === 404) return err(404, "not found");
    if (res.status !== 200 && res.status !== 206) return err(502, "storage error");
    const h = {
      "Content-Type": key.endsWith(".mov") ? "video/quicktime" : "image/jpeg",
      "Cache-Control": p.kind === "live" ? "no-store" : "private, max-age=31536000, immutable",
      "Accept-Ranges": "bytes"
    };
    for (const k of ["Content-Length", "Content-Range", "ETag", "Last-Modified"]) {
      const v = res.headers.get(k);
      if (v) h[k] = v;
    }
    if (attachment) h["Content-Disposition"] = 'attachment; filename="' + p.name + '"';
    return new Response(res.body, { status: res.status, headers: h });
  }

  // ----------------------------------------------------------- dispatch --
  async function route(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const kv = kvStore(env.DB, now);
    await count(env, ctx, "worker_requests");

    if (path === "/health") return text("ok\n");
    if (path.startsWith("/mac/")) return macRoute(request, env, url, kv, ctx);

    if (path === "/auth/config" && request.method === "GET") {
      return json({ clientId: env.GOOGLE_CLIENT_ID || "", configured: !!(env.GOOGLE_CLIENT_ID && env.ALLOWED_EMAIL && env.SESSION_SECRET) });
    }
    if (path === "/auth/google" && request.method === "POST") {
      if (!csrfOk(request, url)) return err(403, "forbidden");
      if (!env.GOOGLE_CLIENT_ID || !env.ALLOWED_EMAIL || !env.SESSION_SECRET) return err(503, "sign-in is not set up yet");
      const b = await readJson(request, 16384);
      try {
        await verifyGoogleToken(b && b.credential, { clientId: env.GOOGLE_CLIENT_ID, allowedEmail: env.ALLOWED_EMAIL, now: now(), googleKeys });
      } catch (e) {
        console.log("sign-in refused: " + e.message);          // the reason only, never the token
        return err(403, "not allowed");
      }
      const epoch = num(await kv.get("session_epoch"));
      return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(await makeSession(env, epoch, now()), SESSION_DAYS * 86400) });
    }
    if (path === "/auth/logout" && request.method === "POST") {
      if (!csrfOk(request, url)) return err(403, "forbidden");
      if (await checkSession(request, env, kv, now())) {
        await kv.set("session_epoch", num(await kv.get("session_epoch")) + 1);   // signs out every device
      }
      return json({ ok: true }, 200, { "Set-Cookie": cookieHeader("x.x", 0) });
    }

    const isApi = path.startsWith("/api/"), isImg = path.startsWith("/img/"), isDl = path.startsWith("/dl/");
    if (isApi || isImg || isDl) {
      if (!await checkSession(request, env, kv, now())) return err(401, "signin");
      if (isApi) return apiRoute(request, env, url, kv, ctx);
      if (request.method !== "GET" && request.method !== "HEAD") return err(405, "method");
      return objectRoute(request, env, url, kv, ctx, isDl);
    }

    if (request.method !== "GET" && request.method !== "HEAD") return err(405, "method");
    if (!env.ASSETS) return err(404, "not found");
    const res = await env.ASSETS.fetch(request);
    return new Response(res.body, { status: res.status, headers: Object.assign(Object.fromEntries(res.headers), { "Cache-Control": "no-cache" }) });
  }

  // --------------------------------------------------------- cron jobs --
  async function every15(env) {
    const t = now();
    const kv = kvStore(env.DB, now);
    await env.DB.prepare("DELETE FROM commands WHERE created < ?").bind(t - 86400).run();
    await env.DB.prepare("DELETE FROM files WHERE kind = 'live' AND uploaded < ?").bind(t - 2 * 86400).run();   // B2 lifecycle deletes the bytes
    const settings = await settingsOf(kv);
    const budget = { left: SUBREQ_BUDGET };
    const b2 = deps.b2(env, { kv, budget, now });
    const out = { retention: 0, guard: 0 };

    // 1. retention (RETENTION_DAYS, default 14). keep/ is never touched.
    const cutoff = utcDay(t - Logic.effective(settings, "RETENTION_DAYS") * 86400);
    const old = (await env.DB.prepare("SELECT key, bytes FROM files WHERE kind IN ('shots','thumbs','recordings') AND day < ? ORDER BY day, key LIMIT 200").bind(cutoff).all()).results || [];
    if (old.length) out.retention = (await purgeRows(env.DB, b2, old, budget)).deleted;

    // 2. storage guard: above the soft limit, delete the oldest non-keep days until 1 GB under it.
    const limit = Logic.effective(settings, "STORAGE_SOFT_LIMIT_GB") * 1e9;
    const { used } = await storageTotals(env.DB);
    if (used > limit && budget.left > 2) {
      const target = limit - 1e9;
      let excess = used - target;
      const days = (await env.DB.prepare("SELECT day, SUM(bytes) AS b FROM files WHERE kind IN ('shots','thumbs','recordings') GROUP BY day ORDER BY day LIMIT 60").all()).results || [];
      const pick = [];
      for (const d of days) { if (excess <= 0) break; pick.push(d.day); excess -= num(d.b); }
      if (pick.length) {
        const rows = (await env.DB.prepare("SELECT key, bytes FROM files WHERE kind IN ('shots','thumbs','recordings') AND day IN (" + pick.map(() => "?").join(",") + ") ORDER BY day, key LIMIT 200").bind(...pick).all()).results || [];
        out.guard = (await purgeRows(env.DB, b2, rows, budget)).deleted;
        await kv.set("guard_last", JSON.stringify({ t, usedBefore: used, limit, days: pick, deleted: out.guard }));
      }
    }
    return out;
  }

  // Daily: list the whole bucket and make D1 match it (fixes any drift).
  async function reconcile(env) {
    const t = now();
    const kv = kvStore(env.DB, now);
    const budget = { left: SUBREQ_BUDGET };
    const b2 = deps.b2(env, { kv, budget, now });
    const seen = new Map();
    let start = null, complete = false;
    try {
      for (;;) {
        const page = await b2.list("", start, 1000);
        for (const f of page.files) if (Logic.parseKey(f.name)) seen.set(f.name, f);
        if (!page.next) { complete = true; break; }
        start = page.next;
      }
    } catch (e) {
      if (!(e instanceof BudgetError)) throw e;
    }
    const have = new Map(((await env.DB.prepare("SELECT key, bytes, uploaded FROM files").all()).results || []).map((r) => [r.key, r]));
    const add = [];
    for (const [k, f] of seen) {
      const h = have.get(k);
      if (!h || num(h.bytes) !== num(f.size)) {
        const p = Logic.parseKey(k);
        add.push({ key: k, kind: p.kind, day: p.day, name: p.name, bytes: num(f.size), reason: p.kind === "live" ? "live" : reasonOf(p.name),
                   uploaded: h ? num(h.uploaded) : Math.floor(num(f.ts) / 1000) || t });
      }
    }
    await upsertFiles(env.DB, add);
    let removed = 0;
    if (complete) {
      // rows the bucket no longer has (deleted elsewhere, or by the lifecycle backstop)
      const stale = [];
      for (const [k, h] of have) if (!seen.has(k) && num(h.uploaded) < t - 600) stale.push(k);
      await deleteRows(env.DB, stale);
      removed = stale.length;
    }
    const res = { t, complete, files: seen.size, added: add.length, removed };
    await kv.set("reconcile_last", JSON.stringify(res));
    return res;
  }

  return {
    async fetch(request, env, ctx) {
      let res;
      try {
        res = await route(request, env, ctx);
      } catch (e) {
        if (e && e.status === 413) res = err(413, "too large");
        else { console.log("error: " + (e && e.message)); res = err(500, "internal error"); }
      }
      return withSecurity(res);
    },
    async scheduled(event, env, ctx) {
      if (event.cron === "17 3 * * *") return reconcile(env);
      return every15(env);
    },
    reconcile, every15
  };
}
