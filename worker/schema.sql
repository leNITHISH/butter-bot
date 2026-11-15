-- mac-watch Worker database (Cloudflare D1 = SQLite).
-- Load with:  npx wrangler d1 execute macwatch --remote --file schema.sql
-- Safe to run again: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS files (
  key      TEXT PRIMARY KEY,           -- e.g. shots/2026-11-15/20261115-120301-space.jpg
  kind     TEXT NOT NULL,              -- shots | thumbs | recordings | keep | live
  day      TEXT NOT NULL,              -- YYYY-MM-DD ('' for live)
  name     TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  reason   TEXT NOT NULL DEFAULT '',
  uploaded INTEGER NOT NULL            -- unix time the Worker learned about it
);
CREATE INDEX IF NOT EXISTS files_by_day ON files(kind, day, name);

CREATE TABLE IF NOT EXISTS commands (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  created INTEGER NOT NULL,
  acked   INTEGER
);

-- small values: status_json, settings, mac (last seen + pause state), watching_until,
-- live_until, live_key, b2_auth, session_epoch, reconcile_last, guard_last
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER NOT NULL);

-- sampled request counters (add 10 with probability 1/10): estimates only
CREATE TABLE IF NOT EXISTS usage (
  day             TEXT PRIMARY KEY,
  worker_requests INTEGER NOT NULL DEFAULT 0,
  b2_downloads    INTEGER NOT NULL DEFAULT 0
);
