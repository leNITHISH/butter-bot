/* mac-watch dashboard UI. All data lives in your Google Drive; this page only holds a
   short-lived Google access token in memory (never in storage). Text from Drive is always
   written with textContent, never as HTML. */
(function () {
  "use strict";
  var L = window.MacWatchLogic;
  var D = window.MacWatchDrive;
  var cfg = window.MACWATCH_CONFIG || {};
  var ROOT = cfg.driveFolder || "mac-watch";
  var SCOPE = "https://www.googleapis.com/auth/drive";

  var token = null;
  var tokenClient = null;
  var drive = D.createDrive({
    fetch: window.fetch.bind(window),
    getToken: function () { return token; }
  });
  var ids = {};            // control / shots / recordings / keep folder ids
  var dayFolderId = null;  // folder of the day shown in the screenshot grid
  var files = [];          // files of that day, newest first
  var shown = 0;
  var urls = [];           // object URLs to revoke on re-render
  var statusTimer = null;
  var lastStatus = null;

  function $(id) { return document.getElementById(id); }
  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function nowSec() { return Math.floor(Date.now() / 1000); }

  var toastTimer = null;
  function toast(msg, isError) {
    var t = $("toast");
    t.textContent = msg;
    t.className = isError ? "error" : "";
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 8000 : 3500);
  }

  // Run an async action; show errors instead of failing silently; go back to sign-in on 401.
  function guard(fn) {
    return function () {
      var args = arguments;
      return Promise.resolve().then(function () { return fn.apply(null, args); }).catch(function (e) {
        if (e && e.code === 401) { signedOut("Your Google sign-in expired. Please sign in again."); return; }
        toast((e && e.message) || String(e), true);
      });
    };
  }

  // ------------------------------------------------------------------ sign-in
  function setupProblem() {
    var id = cfg.clientId || "";
    if (!id || id.indexOf("PASTE_") === 0) return "This page is not set up yet: put your Google Web client ID into web/config.js (see web/README.md).";
    if (!window.google || !window.google.accounts) return "Google's sign-in script has not loaded yet. Check your connection and reload.";
    return "";
  }

  function signIn() {
    var problem = setupProblem();
    $("setup-msg").hidden = !problem;
    $("setup-msg").textContent = problem;
    if (problem) return;
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: cfg.clientId,
        scope: SCOPE,
        callback: function (resp) {
          if (resp.error || !resp.access_token) { toast("Sign-in failed: " + (resp.error || "no token"), true); return; }
          token = resp.access_token;
          start();
        },
        error_callback: function (err) { toast("Sign-in cancelled or blocked: " + (err && err.type || "unknown"), true); }
      });
    }
    tokenClient.requestAccessToken({ prompt: "" });
  }

  function signedOut(msg) {
    token = null;
    drive.forget();
    clearInterval(statusTimer);
    $("app").hidden = true;
    $("signin").hidden = false;
    $("signout").hidden = true;
    if (msg) { $("setup-msg").hidden = false; $("setup-msg").textContent = msg; }
  }

  function signOut() {
    var t = token;
    if (t && window.google && window.google.accounts) window.google.accounts.oauth2.revoke(t, function () {});
    signedOut("");
  }

  // ------------------------------------------------------------------ startup
  var start = guard(function () {
    $("signin").hidden = true;
    $("app").hidden = false;
    $("signout").hidden = false;
    return Promise.all([
      drive.folderId(ROOT + "/control", true),
      drive.folderId(ROOT + "/shots", true),
      drive.folderId(ROOT + "/recordings", true),
      drive.folderId(ROOT + "/keep", true)
    ]).then(function (r) {
      ids = { control: r[0], shots: r[1], recordings: r[2], keep: r[3] };
      buildSettingsForm();
      return Promise.all([refreshStatus(), loadDays(), loadRecordings(), loadSettings()]);
    }).then(function () {
      clearInterval(statusTimer);
      statusTimer = setInterval(function () { if (!document.hidden && token) refreshStatus(); }, 60000);
    });
  });

  // ------------------------------------------------------------------- status
  var refreshStatus = guard(function () {
    return drive.findChild(ids.control, "status.json").then(function (f) {
      if (!f) { renderStatus(null); return; }
      return drive.readText(f.id).then(function (t) {
        var s = null;
        try { s = JSON.parse(t); } catch (e) { s = null; }
        renderStatus(s);
      });
    });
  });

  function row(dl, k, v) { dl.appendChild(el("dt", k)); dl.appendChild(el("dd", v)); }

  function renderStatus(s) {
    lastStatus = s;
    var dl = $("status-list");
    clear(dl);
    var h = L.statusHealth(s && s.updated, nowSec());
    $("health-text").textContent = h.text;
    $("health-dot").className = "dot " + h.level;
    $("status-errors").hidden = !(s && s.errors);
    if (s && s.errors) $("status-errors").textContent = "Problems on the Mac: " + s.errors;
    if (!s) return;
    var lc = s.lastCapture || {};
    row(dl, "Computer", s.host || "?");
    row(dl, "Lid", s.lid + (s.paused === "no" ? "" : "  (paused: " + (s.paused === "local" ? "PAUSE file on the Mac" : "from here") + ")"));
    row(dl, "Last shot", lc.epoch ? L.ageString(nowSec() - lc.epoch) + " ago (" + lc.reason + ", " + lc.result + ")" : "none yet");
    row(dl, "Waiting to upload", String(s.queue));
    row(dl, "Online", s.online || "?");
    row(dl, "Power", (s.battery || "?") + ", " + s.power);
    row(dl, "Up for", s.uptime || "?");
    row(dl, "Screenshot every", s.intervalSec + " s" + (s.remoteSettings ? "  (" + s.remoteSettings + " setting(s) set from here)" : ""));
    row(dl, "Spacebar helper", s.hammerspoon === "off" ? "not enabled" : s.hammerspoon);
    $("cmd-pause").disabled = s.paused === "remote";
    $("cmd-resume").disabled = s.paused !== "remote";
  }

  // ----------------------------------------------------------------- commands
  var sendCommand = guard(function (kind, label) {
    var name = L.COMMANDS[kind];
    return drive.findChild(ids.control, name).then(function (f) {
      if (f) { toast("That command is already waiting for the Mac."); return; }
      return drive.createFolder(ids.control, name).then(function () {
        toast(label + ": sent. The Mac picks it up within about a minute.");
        if (kind === "snap") watchForNewShot();
        if (kind === "pause" || kind === "resume") setTimeout(refreshStatus, 90000);
      });
    });
  });

  // After "Screenshot now", look for the new -remote.jpg for up to 4 minutes.
  var watching = false;
  function watchForNewShot() {
    if (watching) return;
    watching = true;
    var before = {};
    files.forEach(function (f) { before[f.id] = true; });
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (tries > 30 || !token) { clearInterval(timer); watching = false; return; }
      guard(function () {
        return loadDays().then(function () {
          var fresh = files.filter(function (f) { return !before[f.id] && /-remote(-\d+)?\.jpg$/.test(f.name); });
          if (fresh.length) { clearInterval(timer); watching = false; toast("New screenshot arrived."); }
        });
      })();
    }, 8000);
  }

  // ------------------------------------------------------------- screenshots
  var loadDays = guard(function () {
    return drive.list(ids.shots, "mimeType = '" + D.FOLDER + "'", { orderBy: "name desc", pageSize: 60 }).then(function (days) {
      var sel = $("day-select");
      var keepSel = sel.value;
      clear(sel);
      days.forEach(function (d) { var o = el("option", d.name); o.value = d.id; sel.appendChild(o); });
      if (!days.length) { dayFolderId = null; files = []; renderGrid(); return; }
      if (keepSel && days.some(function (d) { return d.id === keepSel; })) sel.value = keepSel;
      return loadDay(sel.value);
    });
  });

  function loadDay(folderId) {
    dayFolderId = folderId;
    return drive.list(folderId, "mimeType != '" + D.FOLDER + "'", { orderBy: "name desc", pageSize: 200 }).then(function (f) {
      files = f;
      shown = 0;
      renderGrid();
    });
  }

  function revokeUrls() { urls.forEach(function (u) { URL.revokeObjectURL(u); }); urls = []; }

  function renderGrid() {
    revokeUrls();
    var grid = $("grid");
    clear(grid);
    $("grid-empty").hidden = files.length > 0;
    shown = 0;
    showMore();
  }

  var queue = [], active = 0;
  function loadThumb(file, img) {
    queue.push(function (done) {
      drive.readBlob(file.id).then(function (b) {
        var u = URL.createObjectURL(b); urls.push(u); img.src = u;
      }).catch(function () {}).then(done);
    });
    pump();
  }
  function pump() {
    while (active < 4 && queue.length) {
      active++;
      queue.shift()(function () { active--; pump(); });
    }
  }

  function showMore() {
    var grid = $("grid");
    var next = files.slice(shown, shown + 24);
    next.forEach(function (f) {
      var info = L.parseShotName(f.name);
      var b = el("button", null, "thumb");
      b.type = "button";
      b.setAttribute("aria-label", "Open screenshot from " + (info.time || f.name) + ", reason " + (info.reason || "unknown"));
      var img = document.createElement("img");
      img.alt = "";
      b.appendChild(img);
      b.appendChild(el("span", (info.time || f.name) + "  " + info.reason));
      b.addEventListener("click", function () { openViewer(f, "image"); });
      grid.appendChild(b);
      loadThumb(f, img);
    });
    shown += next.length;
    $("grid-more").hidden = shown >= files.length;
  }

  // ------------------------------------------------------------------ viewer
  var viewing = null;
  var viewerUrl = null;

  function openViewer(file, kind, parentId) {
    viewing = { file: file, parent: parentId || dayFolderId };
    var body = $("viewer-body");
    clear(body);
    $("viewer-meta").textContent = file.name + (file.size ? "  (" + L.formatBytes(file.size) + ")" : "");
    $("viewer-download").removeAttribute("href");
    $("viewer").showModal();
    if (kind === "video" && Number(file.size) > 100 * 1048576 &&
        !window.confirm("This recording is " + L.formatBytes(file.size) + ". Load it?")) { $("viewer").close(); return; }
    guard(function () {
      return drive.readBlob(file.id).then(function (blob) {
        if (viewerUrl) URL.revokeObjectURL(viewerUrl);
        viewerUrl = URL.createObjectURL(blob);
        var m = kind === "video" ? document.createElement("video") : document.createElement("img");
        if (kind === "video") { m.controls = true; m.playsInline = true; } else { m.alt = file.name; }
        m.src = viewerUrl;
        body.appendChild(m);
        var a = $("viewer-download");
        a.href = viewerUrl;
        a.download = file.name;
      });
    })();
  }

  var keepCurrent = guard(function () {
    if (!viewing) return;
    var info = L.parseShotName(viewing.file.name);
    var day = info.date || "unsorted";
    return drive.folderId(ROOT + "/keep/" + day, true).then(function (kid) {
      return drive.move(viewing.file.id, viewing.parent, kid).then(function () {
        toast("Moved to keep/" + day + " (never auto-deleted).");
        $("viewer").close();
        files = files.filter(function (f) { return f.id !== viewing.file.id; });
        renderGrid();
        loadRecordings();
      });
    });
  });

  // -------------------------------------------------------------- recordings
  var loadRecordings = guard(function () {
    return drive.list(ids.recordings, "mimeType = '" + D.FOLDER + "'", { orderBy: "name desc", pageSize: 3 }).then(function (days) {
      var ul = $("rec-list");
      clear(ul);
      return Promise.all(days.map(function (d) {
        return drive.list(d.id, "mimeType != '" + D.FOLDER + "'", { orderBy: "name desc", pageSize: 20 }).then(function (fs) {
          return { day: d, files: fs };
        });
      })).then(function (groups) {
        var count = 0;
        groups.forEach(function (g) {
          g.files.forEach(function (f) {
            count++;
            var li = document.createElement("li");
            li.appendChild(el("span", f.name + "  (" + L.formatBytes(f.size) + ")"));
            var play = el("button", "Play"); play.type = "button";
            play.addEventListener("click", function () { openViewer(f, "video", g.day.id); });
            li.appendChild(play);
            ul.appendChild(li);
          });
        });
        $("rec-empty").hidden = count > 0;
      });
    });
  });

  // ---------------------------------------------------------------- settings
  function buildSettingsForm() {
    var form = $("settings-form");
    clear(form);
    L.SETTINGS.forEach(function (s) {
      var label = el("label", s.label);
      label.setAttribute("for", "set-" + s.key);
      var input = document.createElement("input");
      input.type = "number"; input.id = "set-" + s.key; input.min = s.min; input.max = s.max; input.step = 1;
      input.inputMode = "numeric"; input.placeholder = "Mac default";
      form.appendChild(label);
      form.appendChild(input);
      form.appendChild(el("p", "Allowed: " + s.min + " to " + s.max + (s.help ? ". " + s.help : ""), "small"));
    });
    form.addEventListener("submit", function (e) { e.preventDefault(); });
  }

  var loadSettings = guard(function () {
    return drive.findChild(ids.control, "config.remote").then(function (f) {
      var vals = {};
      var p = f ? drive.readText(f.id).then(function (t) { vals = L.parseConfig(t); }) : Promise.resolve();
      return p.then(function () {
        L.SETTINGS.forEach(function (s) { $("set-" + s.key).value = vals[s.key] === undefined ? "" : vals[s.key]; });
      });
    });
  });

  var saveSettings = guard(function () {
    var values = {};
    L.SETTINGS.forEach(function (s) { values[s.key] = $("set-" + s.key).value; });
    var res = L.buildConfig(values);
    $("settings-errors").hidden = res.errors.length === 0;
    $("settings-errors").textContent = res.errors.join(". ");
    if (res.errors.length) return;
    return drive.writeText(ids.control, "config.remote", res.text).then(function () {
      toast("Saved. The Mac applies it within about a minute.");
      setTimeout(refreshStatus, 90000);
    });
  });

  var resetSettings = guard(function () {
    if (!window.confirm("Remove all settings made here and use the Mac's own config.env?")) return;
    return drive.findChild(ids.control, "config.remote").then(function (f) {
      return f ? drive.remove(f.id) : null;
    }).then(function () { return loadSettings(); }).then(function () { toast("Removed. The Mac goes back to config.env within about a minute."); });
  });

  // ------------------------------------------------------------------- wiring
  $("signin-btn").addEventListener("click", signIn);
  $("signout").addEventListener("click", signOut);
  $("status-refresh").addEventListener("click", refreshStatus);
  $("cmd-snap").addEventListener("click", function () { sendCommand("snap", "Screenshot"); });
  $("cmd-record").addEventListener("click", function () { sendCommand("record", "Recording"); });
  $("cmd-pause").addEventListener("click", function () { sendCommand("pause", "Pause"); });
  $("cmd-resume").addEventListener("click", function () { sendCommand("resume", "Resume"); });
  $("day-select").addEventListener("change", guard(function () { return loadDay($("day-select").value); }));
  $("grid-more").addEventListener("click", showMore);
  $("settings-save").addEventListener("click", saveSettings);
  $("settings-reset").addEventListener("click", resetSettings);
  $("viewer-keep").addEventListener("click", keepCurrent);
  $("viewer-close").addEventListener("click", function () { $("viewer").close(); });
  $("viewer").addEventListener("close", function () {
    clear($("viewer-body"));
    if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
  });
  window.addEventListener("load", function () { var p = setupProblem(); if (p && /not set up/.test(p)) { $("setup-msg").hidden = false; $("setup-msg").textContent = p; } });
})();
