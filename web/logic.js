/* mac-watch: pure logic shared by the web page (browser) and the Worker (bundled), also loaded by
   the node tests. No DOM, no network. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MacWatchLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Settings that can be changed from the web page. Numbers only. The Worker validates them
  // (validateSettings), and the Mac validates the ones it receives AGAIN with its own table
  // (bin/lib.sh: remote_bounds). tests/ check that the two tables match.
  // worker: true = used by the Worker only, never sent to the Mac.
  var SETTINGS = [
    { key: "INTERVAL_SEC", label: "Screenshot every (seconds)", min: 30, max: 86400, def: 300, help: "Normal: 300 (5 minutes)." },
    { key: "SPACE_MIN_GAP_SEC", label: "Spacebar shots: at most one per (seconds)", min: 5, max: 3600, def: 30, help: "Taken 3 s after you stop typing." },
    { key: "EVENT_MIN_GAP_SEC", label: "Wake / lock / unlock shots: at most one per (seconds)", min: 5, max: 3600, def: 30, help: "" },
    { key: "SKIP_IDENTICAL", label: "Skip unchanged screens (1 = yes, 0 = no)", min: 0, max: 1, def: 1, help: "" },
    { key: "SKIP_MAX_AGE_SEC", label: "...but keep at least one shot per (seconds)", min: 60, max: 86400, def: 3600, help: "" },
    { key: "JPEG_QUALITY", label: "JPEG quality", min: 10, max: 100, def: 60, help: "Lower = smaller files." },
    { key: "MAX_WIDTH", label: "Maximum picture width (pixels)", min: 320, max: 4000, def: 1440, help: "" },
    { key: "RECORD_SEC", label: "Recording length (seconds)", min: 10, max: 1800, def: 300, help: "Used by the Record button." },
    { key: "UPLOAD_EVERY_SEC", label: "Upload in batches every (seconds)", min: 0, max: 3600, def: 300, help: "\"Screenshot now\" is always sent at once." },
    { key: "KEEP_AWAKE", label: "Keep the Mac awake while the lid is open (1 = yes, 0 = no)", min: 0, max: 1, def: 0, help: "Uses more battery." },
    { key: "MARKER_MAX_AGE_MIN", label: "Ignore commands older than (minutes)", min: 1, max: 1440, def: 30, help: "A command sent while the Mac was asleep runs only if it wakes within this time." },
    { key: "RETENTION_DAYS", label: "Delete shots and recordings after (days)", min: 3, max: 365, def: 14, help: "Files you Keep are never deleted." },
    { key: "STORAGE_SOFT_LIMIT_GB", label: "Storage guard: delete oldest days above (GB)", min: 1, max: 9, def: 8, worker: true, help: "Backblaze is free up to 10 GB. Kept files are never deleted." }
  ];

  function settingByKey(k) {
    for (var i = 0; i < SETTINGS.length; i++) if (SETTINGS[i].key === k) return SETTINGS[i];
    return null;
  }

  // The keys the Mac accepts (must equal bin/lib.sh remote_keys).
  function macKeys() {
    return SETTINGS.filter(function (s) { return !s.worker; }).map(function (s) { return s.key; });
  }

  // { KEY: value } -> { values: { KEY: number }, errors: [..] }. Empty values = "not overridden".
  // Unknown keys and anything that is not a whole number in range are errors.
  function validateSettings(input) {
    var values = {}, errors = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) return { values: values, errors: ["settings must be an object"] };
    Object.keys(input).forEach(function (k) {
      var s = settingByKey(k), raw = input[k];
      if (!s) { errors.push("unknown setting " + String(k).slice(0, 40)); return; }
      if (raw === undefined || raw === null || raw === "") return;
      var v = typeof raw === "number" ? raw : (/^\d{1,7}$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN);
      if (!Number.isInteger(v) || v < s.min || v > s.max) {
        errors.push(s.key + " must be a whole number from " + s.min + " to " + s.max);
        return;
      }
      values[k] = v;
    });
    return { values: values, errors: errors };
  }

  // The effective value of a setting: the override, else the default.
  function effective(values, key) {
    var s = settingByKey(key);
    if (values && Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    return s ? s.def : undefined;
  }

  function ageString(seconds) {
    var s = Math.max(0, Math.round(seconds));
    if (s < 90) return s + " s";
    if (s < 5400) return Math.round(s / 60) + " min";
    if (s < 172800) return Math.round(s / 3600) + " h";
    return Math.round(s / 86400) + " days";
  }

  // How long since the Mac last polled the Worker (it polls every 20 s while awake).
  function seenHealth(lastSeenEpoch, nowEpoch) {
    if (!lastSeenEpoch) return { level: "bad", text: "The Mac has not connected yet" };
    var age = nowEpoch - lastSeenEpoch;
    if (age < 8 * 60) return { level: "ok", text: "Mac seen " + ageString(age) + " ago" };
    if (age < 20 * 60) return { level: "warn", text: "Mac last seen " + ageString(age) + " ago" };
    return {
      level: "bad",
      text: "Mac last seen " + ageString(age) + " ago: asleep, offline, lid closed, or PAUSE file"
    };
  }

  // 20261113-152800-space.jpg -> { date:"2026-11-13", time:"15:28:00", reason:"space" }
  function parseShotName(name) {
    var m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([a-z0-9-]+?)(?:-\d+)?\.(jpg|mov)$/.exec(name);
    if (!m) return { date: "", time: "", reason: "" };
    return { date: m[1] + "-" + m[2] + "-" + m[3], time: m[4] + ":" + m[5] + ":" + m[6], reason: m[7] };
  }

  // Decimal units, like Backblaze ("10 GB free" = 10,000,000,000 bytes).
  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1000) return n + " B";
    if (n < 1e6) return Math.round(n / 1e3) + " KB";
    if (n < 1e9) return (n / 1e6).toFixed(1) + " MB";
    return (n / 1e9).toFixed(2) + " GB";
  }

  // Storage meter colour: amber from 70 %, red from 90 %.
  function meterLevel(fraction) {
    if (fraction >= 0.9) return "bad";
    if (fraction >= 0.7) return "warn";
    return "ok";
  }

  // Object keys the Worker accepts anywhere (the same regexes are used server-side).
  var KEY_RE = /^(shots|thumbs|recordings|keep)\/(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9._-]+\.(?:jpg|mov))$/;
  var LIVE_RE = /^live\/([A-Za-z0-9._-]+\.jpg)$/;
  function parseKey(key) {
    if (typeof key !== "string" || key.length > 200) return null;
    var m = KEY_RE.exec(key);
    if (m) return { kind: m[1], day: m[2], name: m[3] };
    m = LIVE_RE.exec(key);
    if (m) return { kind: "live", day: "", name: m[1] };
    return null;
  }

  var COMMANDS = ["snap", "record", "pause", "resume", "live-on", "live-off"];

  return {
    SETTINGS: SETTINGS, COMMANDS: COMMANDS, KEY_RE: KEY_RE, LIVE_RE: LIVE_RE,
    settingByKey: settingByKey, macKeys: macKeys, validateSettings: validateSettings, effective: effective,
    ageString: ageString, seenHealth: seenHealth, parseShotName: parseShotName,
    formatBytes: formatBytes, meterLevel: meterLevel, parseKey: parseKey
  };
});
