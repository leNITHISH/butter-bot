// Test doubles for the Worker: a D1-compatible wrapper around node:sqlite, an in-memory or
// directory-backed fake B2, a fake ASSETS binding, and a Google key pair to sign ID tokens.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BudgetError } from "../worker/b2.js";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

// ---- D1 over node:sqlite --------------------------------------------------------------
class Stmt {
  constructor(db, sql, args) { this.db = db; this.sql = sql; this.args = args || []; }
  bind(...args) {
    for (const a of args) if (a === undefined || typeof a === "boolean") throw new Error("D1 cannot bind " + typeof a + " in: " + this.sql);
    return new Stmt(this.db, this.sql, args);
  }
  _p() { return this.db.prepare(this.sql); }
  async first(col) { const r = this._p().get(...this.args); if (!r) return null; return col ? r[col] : Object.assign({}, r); }
  async all() { return { success: true, results: this._p().all(...this.args).map((r) => Object.assign({}, r)), meta: {} }; }
  async run() { const r = this._p().run(...this.args); return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }
  _sync() { return /^\s*(SELECT|.*RETURNING)/is.test(this.sql) ? this._p().all(...this.args) : this._p().run(...this.args); }
}
export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(path.join(ROOT, "worker/schema.sql"), "utf8"));
  return {
    raw: db,
    prepare(sql) { return new Stmt(db, sql); },
    async batch(stmts) {
      db.exec("BEGIN");
      try { const out = stmts.map((s) => ({ success: true, results: s._sync() })); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    async exec(sql) { db.exec(sql); }
  };
}

// ---- fake B2 ---------------------------------------------------------------------------
// Objects live in a Map (or, with dir, as files under dir/ so the shell tests' fake rclone and
// this fake see the same bucket). Every call spends budget like the real client.
export function makeFakeB2(opts = {}) {
  const mem = new Map();          // name -> { id, bytes: Buffer, ts }
  const calls = [];
  let n = 0;
  const dir = opts.dir;
  function all() {
    if (!dir) return mem;
    const out = new Map();
    const walk = (d, pre) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name), k = pre + e.name;
        if (e.isDirectory()) walk(p, k + "/");
        else { const st = fs.statSync(p); out.set(k, { id: "id:" + k, size: st.size, ts: Math.floor(st.mtimeMs), file: p }); }
      }
    };
    walk(dir, "");
    return out;
  }
  const factory = (env, { budget }) => {
    const spend = (op) => { calls.push(op); if (budget.left <= 0) throw new BudgetError("budget"); budget.left--; };
    return {
      async list(prefix, start, max) {
        spend("list");
        const names = [...all().keys()].filter((k) => k.startsWith(prefix || "") && (!start || k >= start)).sort();
        const page = names.slice(0, max || 1000);
        const objs = all();
        return { files: page.map((k) => ({ name: k, id: objs.get(k).id, size: objs.get(k).size !== undefined ? objs.get(k).size : objs.get(k).bytes.length, ts: objs.get(k).ts })),
                 next: names.length > page.length ? names[page.length] : null };
      },
      async remove(name, id) {
        spend("delete");
        const o = all().get(name);
        if (!o || o.id !== id) { const e = new Error("B2 b2_delete_file_version failed: HTTP 400"); e.status = 400; throw e; }
        if (dir) fs.unlinkSync(o.file); else mem.delete(name);
        return {};
      },
      async copy(srcId, newName) {
        spend("copy");
        const src = [...all().entries()].find(([, o]) => o.id === srcId);
        if (!src) throw new Error("no source");
        if (dir) {
          fs.mkdirSync(path.dirname(path.join(dir, newName)), { recursive: true });
          fs.copyFileSync(src[1].file, path.join(dir, newName));
          return { name: newName, id: "id:" + newName, size: src[1].size };
        }
        const o = { id: "id" + (++n), bytes: src[1].bytes, ts: Date.now() };
        mem.set(newName, o);
        return { name: newName, id: o.id, size: o.bytes.length };
      },
      async download(key, range) {
        spend("download");
        const o = all().get(key);
        if (!o) return new Response("nf", { status: 404 });
        let body = dir ? fs.readFileSync(o.file) : o.bytes;
        const m = /^bytes=(\d+)-(\d*)$/.exec(range || "");
        if (m) {
          const a = Number(m[1]), b = m[2] ? Number(m[2]) : body.length - 1;
          const part = body.subarray(a, b + 1);
          return new Response(part, { status: 206, headers: { "Content-Length": String(part.length), "Content-Range": "bytes " + a + "-" + b + "/" + body.length } });
        }
        return new Response(body, { status: 200, headers: { "Content-Length": String(body.length) } });
      }
    };
  };
  return {
    factory, calls, mem,
    put(name, content) {
      const bytes = Buffer.from(content);
      if (dir) { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); }
      else mem.set(name, { id: "id" + (++n), bytes, ts: Date.now() });
    },
    has(name) { return all().has(name); },
    names() { return [...all().keys()].sort(); }
  };
}

// ---- ASSETS ----------------------------------------------------------------------------
export function makeAssets() {
  return {
    async fetch(request) {
      let p = new URL(request.url).pathname;
      if (p === "/") p = "/index.html";
      const f = path.join(ROOT, "web", path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
      if (!f.startsWith(path.join(ROOT, "web")) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return new Response("not found", { status: 404 });
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(f)] || "application/octet-stream";
      return new Response(fs.readFileSync(f), { headers: { "Content-Type": type } });
    }
  };
}

// ---- Google ----------------------------------------------------------------------------
export function makeGoogle() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = Object.assign(publicKey.export({ format: "jwk" }), { kid: "k1", alg: "RS256", use: "sig" });
  const b64u = (b) => Buffer.from(b).toString("base64url");
  return {
    keys: [jwk],
    sign(payload, opts = {}) {
      const header = { alg: opts.alg || "RS256", kid: opts.kid || "k1", typ: "JWT" };
      const data = b64u(JSON.stringify(header)) + "." + b64u(JSON.stringify(payload));
      const sig = crypto.sign("sha256", Buffer.from(data), opts.wrongKey ? other.privateKey : privateKey);
      return data + "." + b64u(sig);
    }
  };
}
