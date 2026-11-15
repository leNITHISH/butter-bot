// The real Worker code (worker/core.js) behind a localhost HTTP server, for the shell tests:
// the Mac scripts talk to it with real curl. D1 = node:sqlite, B2 = a folder that the fake
// rclone also writes into, so what the Mac "uploads" is what the Worker serves.
//   node tests/fake_worker.mjs PORTFILE BUCKET_DIR MAC_TOKEN_HASH
// Test-only routes (not in the real Worker): /__test/cmd, /__test/dump, /__test/settings, /__test/kv
import http from "node:http";
import fs from "node:fs";
import { makeApp } from "../worker/core.js";
import { makeD1, makeFakeB2, makeAssets } from "./fakes.mjs";

const [portFile, bucketDir, macHash] = process.argv.slice(2);
const db = makeD1();
const b2 = makeFakeB2({ dir: bucketDir });
const app = makeApp({ b2: b2.factory, random: () => 0.99, googleKeys: async () => [] });
const env = { DB: db, ASSETS: makeAssets(), MAC_TOKEN_HASH: macHash, SESSION_SECRET: "test-session", ALLOWED_EMAIL: "x@example.com",
              GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com", B2_BUCKET: "bucket", B2_KEY_ID: "k", B2_APP_KEY: "s" };
const now = () => Math.floor(Date.now() / 1000);

async function testRoute(path, body) {
  if (path === "/__test/cmd") {                      // body: "<name> [age-seconds]"
    const [name, age] = body.trim().split(/\s+/);
    const r = await db.prepare("INSERT INTO commands (name, created) VALUES (?, ?) RETURNING id").bind(name, now() - Number(age || 0)).first();
    return String(r.id);
  }
  if (path === "/__test/settings") {
    await db.prepare("INSERT INTO kv (k, v, updated) VALUES ('settings', ?, 0) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(body).run();
    return "ok";
  }
  if (path === "/__test/kv") {                       // body: "<key> <value>"   (value "+N" = now + N)
    const [k, v] = body.trim().split(/\s+/);
    const val = v.startsWith("+") ? String(now() + Number(v.slice(1))) : v;
    await db.prepare("INSERT INTO kv (k, v, updated) VALUES (?, ?, 0) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, val).run();
    return "ok";
  }
  if (path === "/__test/dump") {
    const files = (await db.prepare("SELECT key, bytes FROM files ORDER BY key").all()).results;
    const commands = (await db.prepare("SELECT id, name, acked FROM commands ORDER BY id").all()).results;
    const kv = Object.fromEntries((await db.prepare("SELECT k, v FROM kv").all()).results.map((r) => [r.k, r.v]));
    return JSON.stringify({ files, commands, kv });
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  try {
    if (req.url.startsWith("/__test/")) {
      const out = await testRoute(req.url, body.toString());
      res.writeHead(out === null ? 404 : 200, { "Content-Type": "text/plain" });
      res.end(out || "");
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const request = new Request("http://" + req.headers.host + req.url, {
      method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body
    });
    const r = await app.fetch(request, env, { waitUntil: () => {} });
    const out = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(out);
  } catch (e) {
    res.writeHead(500); res.end(String(e && e.stack));
  }
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile + ".tmp", String(server.address().port));
  fs.renameSync(portFile + ".tmp", portFile);
});
process.on("SIGTERM", () => process.exit(0));
