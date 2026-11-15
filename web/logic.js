/* mac-watch dashboard: pure logic (no DOM, no network). Works in the browser and in node. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MacWatchLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Settings that can be changed from this page. Numbers only, and the ranges are
  // enforced AGAIN on the Mac (bin/lib.sh: remote_bounds). tests/ checks both tables match.
  var SETTINGS = [
    { key: "INTERVAL_SEC", label: "Screenshot every (seconds)", min: 30, max: 86400, help: "Normal: 300 (5 minutes)." },
    { key: "SPACE_MIN_GAP_SEC", label: "Spacebar shots: at most one per (seconds)", min: 5, max: 3600, help: "Taken 3 s after you stop typing." },
    { key: "EVENT_MIN_GAP_SEC", label: "Wake / lock / unlock shots: at most one per (seconds)", min: 5, max: 3600, help: "" },
    { key: "SKIP_IDENTICAL", label: "Skip unchanged screens (1 = yes, 0 = no)", min: 0, max: 1, help: "" },
    { key: "SKIP_MAX_AGE_SEC", label: "...but keep at least one shot per (seconds)", min: 60, max: 86400, help: "" },
    { key: "JPEG_QUALITY", label: "JPEG quality", min: 10, max: 100, help: "Lower = smaller files." },
    { key: "MAX_WIDTH", label: "Maximum picture width (pixels)", min: 320, max: 4000, help: "" },
    { key: "RECORD_SEC", label: "Recording length (seconds)", min: 10, max: 1800, help: "Used by the Record button." },
    { key: "UPLOAD_EVERY_SEC", label: "Upload in batches every (seconds)", min: 0, max: 3600, help: "Higher = fewer Google calls, slower to appear." },
    { key: "RETENTION_DAYS", label: "Delete shots from Drive after (days)", min: 3, max: 365, help: "Files in keep/ are never deleted." },
    { key: "KEEP_AWAKE", label: "Keep the Mac awake while the lid is open (1 = yes, 0 = no)", min: 0, max: 1, help: "Uses more battery." },
    { key: "MARKER_MAX_AGE_MIN", label: "Ignore commands older than (minutes)", min: 1, max: 1440, help: "" }
  ];

  function settingByKey(k) {
    for (var i = 0; i < SETTINGS.length; i++) if (SETTINGS[i].key === k) return SETTINGS[i];
    return null;
  }

  // "KEY=value" lines -> { KEY: number }. Ignores comments and anything invalid.
  function parseConfig(text) {
    var out = {};
    String(text || "").split(/\r?\n/).forEach(function (line) {
      var m = /^([A-Z_]+)=(\d{1,7})$/.exec(line.trim());
      if (!m) return;
      var s = settingByKey(m[1]);
      var v = parseInt(m[2], 10);
      if (s && v >= s.min && v <= s.max) out[m[1]] = v;
    });
    return out;
  }

  // { KEY: value } -> { text, errors }. Refuses out-of-range / non-integer values.
  function buildConfig(values) {
    var lines = ["# written by the mac-watch web page"], errors = [];
    SETTINGS.forEach(function (s) {
      var raw = values[s.key];
      if (raw === undefined || raw === null || raw === "") return;      // not overridden
      var v = Number(raw);
      if (!Number.isInteger(v) || v < s.min || v > s.max) {
        errors.push(s.key + " must be a whole number from " + s.min + " to " + s.max);
        return;
      }
      lines.push(s.key + "=" + v);
    });
    return { text: lines.join("\n") + "\n", errors: errors };
  }

  function ageString(seconds) {
    var s = Math.max(0, Math.round(seconds));
    if (s < 90) return s + " s";
    if (s < 5400) return Math.round(s / 60) + " min";
    if (s < 172800) return Math.round(s / 3600) + " h";
    return Math.round(s / 86400) + " days";
  }

  // The Mac publishes status.json about every 5 minutes while it is awake with the lid open.
  function statusHealth(updatedEpoch, nowEpoch) {
    if (!updatedEpoch) return { level: "bad", text: "No status from the Mac yet" };
    var age = nowEpoch - updatedEpoch;
    if (age < 8 * 60) return { level: "ok", text: "Mac seen " + ageString(age) + " ago" };
    if (age < 20 * 60) return { level: "warn", text: "Mac last seen " + ageString(age) + " ago" };
    return {
      level: "bad",
      text: "Mac last seen " + ageString(age) + " ago: asleep, lid closed, offline, or paused with the PAUSE file"
    };
  }

  // 20261113-152800-space.jpg -> { date:"2026-11-13", time:"15:28:00", reason:"space" }
  function parseShotName(name) {
    var m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([a-z0-9-]+?)(?:-\d+)?\.(jpg|mov)$/.exec(name);
    if (!m) return { date: "", time: "", reason: "" };
    return { date: m[1] + "-" + m[2] + "-" + m[3], time: m[4] + ":" + m[5] + ":" + m[6], reason: m[7] };
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return Math.round(n / 1024) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  // Marker names are matched case-insensitively by prefix on the Mac.
  var COMMANDS = { snap: "snap-now", record: "record-5min", pause: "pause", resume: "resume" };

  return {
    SETTINGS: SETTINGS, COMMANDS: COMMANDS,
    parseConfig: parseConfig, buildConfig: buildConfig,
    ageString: ageString, statusHealth: statusHealth,
    parseShotName: parseShotName, formatBytes: formatBytes
  };
});
