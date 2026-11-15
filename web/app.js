/* mac-watch web page. Plain JS, no framework. Text from the server is only ever shown with
   textContent (never parsed as HTML). Talks to the Worker through api.js. */
(function () {
  "use strict";
  var L = window.MacWatchLogic;
  var A = window.MacWatchApi;
  var api = A.makeApi(function (p, o) { return fetch(p, o); });

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
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
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 6000 : 3000);
  }
  function fail(e) {
    if (e && e.status === 401) { showSignIn(); return; }
    toast((e && e.message) || "Something went wrong", true);
  }

  function dl(target, rows) {
    clear(target);
    rows.forEach(function (r) {
      if (r[1] === undefined || r[1] === null || r[1] === "") return;
      target.appendChild(el("dt", "", r[0]));
      target.appendChild(el("dd", r[2] || "", String(r[1])));
    });
  }

  // ------------------------------------------------------------ confirm ---
  var confirmCb = null;
  function ask(text, yesLabel, cb) {
    $("confirm-text").textContent = text;
    $("confirm-yes").textContent = yesLabel || "Delete";
    confirmCb = cb;
    $("confirm").showModal();
  }
  $("confirm-yes").addEventListener("click", function () { $("confirm").close(); var c = confirmCb; confirmCb = null; if (c) c(); });
  $("confirm-no").addEventListener("click", function () { $("confirm").close(); confirmCb = null; });

  // ------------------------------------------------------------ screens ---
  var SCREENS = ["home", "files", "storage", "settings"];
  var current = null;
  var timers = [];
  function stopTimers() { timers.forEach(clearInterval); timers = []; }
  function every(ms, fn) { timers.push(setInterval(function () { if (!document.hidden) fn(); }, ms)); }

  function showSignIn() {
    stopTimers();
    $("nav").hidden = true;
    SCREENS.forEach(function (s) { $("screen-" + s).hidden = true; });
    $("screen-signin").hidden = false;
    current = "signin";
    api.config().then(function (cfg) {
      if (!cfg.configured || !cfg.clientId) {
        $("signin-msg").textContent = "Sign-in is not set up yet. On the laptop: ./worker/put-secrets.sh (needs the Google Client ID, your e-mail and a session secret).";
        return;
      }
      waitForGoogle(20, function (ok) {
        if (!ok) { $("signin-msg").textContent = "Could not load Google sign-in. Check the connection and reload."; return; }
        window.google.accounts.id.initialize({ client_id: cfg.clientId, callback: onCredential, auto_select: true, itp_support: true });
        clear($("gsi-button"));
        window.google.accounts.id.renderButton($("gsi-button"), { theme: "outline", size: "large", text: "signin_with" });
        window.google.accounts.id.prompt();
      });
    }).catch(function () { $("signin-msg").textContent = "Cannot reach the server."; });
  }
  function waitForGoogle(tries, cb) {
    if (window.google && window.google.accounts && window.google.accounts.id) return cb(true);
    if (tries <= 0) return cb(false);
    setTimeout(function () { waitForGoogle(tries - 1, cb); }, 500);
  }
  function onCredential(resp) {
    $("signin-msg").textContent = "Checking...";
    api.signIn(resp.credential).then(function () {
      $("signin-msg").textContent = "";
      route();
    }).catch(function (e) {
      $("signin-msg").textContent = e.status === 403 ? "This Google account is not allowed." : "Sign-in failed: " + e.message;
    });
  }
  $("btn-signout").addEventListener("click", function () {
    api.signOut().catch(function () {}).then(function () {
      if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
      showSignIn();
    });
  });

  function route() {
    var name = (location.hash || "#home").slice(1);
    if (SCREENS.indexOf(name) < 0) name = "home";
    stopTimers();
    api.status().then(function (st) {
      $("screen-signin").hidden = true;
      $("nav").hidden = false;
      SCREENS.forEach(function (s) {
        $("screen-" + s).hidden = s !== name;
        $("nav-" + s).className = s === name ? "active" : "";
      });
      current = name;
      // tell the Mac someone is watching: it polls every 2 s while this is fresh
      api.watching().catch(function () {});
      every(30000, function () { api.watching().catch(fail); });
      if (name === "home") startHome(st);
      if (name === "files") startFiles();
      if (name === "storage") startStorage();
      if (name === "settings") startSettings();
    }).catch(fail);
  }
  window.addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && current && current !== "signin") api.watching().catch(function () {});
  });

  // --------------------------------------------------------------- home ---
  var lastStatus = null;
  function startHome(st) {
    renderStatus(st);
    loadLatest();
    loadHomeStorage();
    every(5000, function () { api.status().then(renderStatus).catch(fail); });
    every(30000, loadHomeStorage);
    every(3000, function () { if (lastStatus && lastStatus.live) loadLive(); });
  }

  function renderStatus(st) {
    lastStatus = st;
    var h = L.seenHealth(st.lastSeen, st.now);
    $("seen-dot").className = "dot " + h.level;
    $("seen-text").textContent = h.text;
    var s = st.status || {};
    var paused = st.macPaused === "remote" ? "paused from this page (press Resume)" :
                 s.paused === "local" ? "paused with the PAUSE file on the Mac (cannot be lifted from here)" : "no";
    var lc = s.lastCapture || {};
    dl($("status-list"), [
      ["Paused", paused, paused === "no" ? "" : "warn"],
      ["Lid", s.lid],
      ["Last shot", lc.epoch ? L.ageString(st.now - lc.epoch) + " ago (" + (lc.reason || "?") + ", " + (lc.result || "?") + ")" : "none yet"],
      ["Battery", s.battery ? s.battery + " (" + (s.power || "?") + ")" : ""],
      ["Waiting to upload", s.queue !== undefined ? s.queue + " file(s)" : ""],
      ["Shot every", s.intervalSec ? s.intervalSec + " s" : ""],
      ["Status from", s.updated ? L.ageString(st.now - s.updated) + " ago" : ""],
      ["Polling", st.watching ? "fast (this page is open)" : "normal"],
      ["Commands waiting", st.pendingCommands ? String(st.pendingCommands) : ""],
      ["Errors", s.errors || "", "bad"]
    ]);
    $("btn-live").textContent = st.live ? "Stop live view" : "Live view";
    $("live-card").hidden = !st.live;
    $("btn-pause").disabled = st.macPaused === "remote";
    $("btn-resume").disabled = st.macPaused !== "remote";
  }

  function command(name, msg) {
    return api.command(name).then(function () { toast(msg); return api.status(); }).then(renderStatus).catch(fail);
  }
  $("btn-snap").addEventListener("click", function () {
    var since = nowSec();
    command("snap", "Sent. The Mac takes it within a few seconds if it is awake.").then(function () {
      // look for the new shot for up to 40 s
      var n = 0;
      var t = setInterval(function () {
        n++;
        loadLatest(since).then(function (found) { if (found || n >= 20) clearInterval(t); });
      }, 2000);
    });
  });
  $("btn-record").addEventListener("click", function () {
    ask("Record the screen now? Length: Settings > Recording length (default 5 minutes). macOS shows its recording indicator. Screen only, no sound.", "Record", function () {
      command("record", "Recording requested. It appears under Files > Recordings when done.");
    });
  });
  $("btn-pause").addEventListener("click", function () { command("pause", "Pause sent."); });
  $("btn-resume").addEventListener("click", function () { command("resume", "Resume sent."); });
  $("btn-live").addEventListener("click", function () {
    var on = !(lastStatus && lastStatus.live);
    command(on ? "live-on" : "live-off", on ? "Live view on: first frame in a few seconds." : "Live view off.").then(function () {
      if (on) loadLive();
    });
  });

  var liveKey = null;
  function loadLive() {
    return api.live().then(function (lv) {
      if (lv && lv.key && lv.key !== liveKey) {
        liveKey = lv.key;
        $("live-img").src = api.imgUrl(lv.key);
      }
      $("live-meta").textContent = lv && lv.taken ? "Frame from " + L.ageString(nowSec() - lv.taken) + " ago" : "Waiting for the first frame...";
    }).catch(fail);
  }

  var latestKey = null;
  function loadLatest(since) {
    return api.days("shots").then(function (d) {
      if (!d.days.length) { $("latest-meta").textContent = "No screenshots yet."; return false; }
      return api.files("shots", d.days[0].day, "", 1).then(function (f) {
        var x = f.files[0];
        if (!x) return false;
        if (x.key !== latestKey) {
          latestKey = x.key;
          $("latest-img").src = api.imgUrl(x.key);
          $("latest-open").hidden = false;
          $("latest-open").onclick = function () { openViewer(x); };
        }
        var p = L.parseShotName(x.name);
        $("latest-meta").textContent = p.date + " " + p.time + " · " + p.reason + " · " + L.formatBytes(x.bytes);
        return !since || x.uploaded >= since;
      });
    }).catch(function (e) { fail(e); return false; });
  }

  function meter(bar, s) {
    bar.style.width = Math.min(100, Math.round(s.fraction * 1000) / 10) + "%";
    bar.className = s.level;
  }
  function loadHomeStorage() {
    return api.storage().then(function (s) {
      meter($("home-meter-bar"), s);
      $("home-storage-text").textContent = L.formatBytes(s.usedBytes) + " of " + L.formatBytes(s.freeBytes) + " free allowance" +
        (s.daysUntilSoftLimit !== null ? " · about " + s.daysUntilSoftLimit + " days until the guard starts deleting" : "");
    }).catch(fail);
  }

  // -------------------------------------------------------------- files ---
  var F = { root: "shots", day: null, next: null, selecting: false, selected: {}, items: [] };

  function startFiles() { showRoot(F.root); }
  ["shots", "recordings", "keep"].forEach(function (k) {
    $("root-" + k).addEventListener("click", function () { showRoot(k); });
  });
  $("btn-files-up").addEventListener("click", function () { showRoot(F.root); });

  function setTabs() {
    ["shots", "recordings", "keep"].forEach(function (k) { $("root-" + k).className = k === F.root ? "active" : ""; });
  }
  function endSelect() {
    F.selecting = false; F.selected = {};
    $("select-bar").hidden = true;
    $("btn-select").textContent = "Select";
    Array.prototype.forEach.call(document.querySelectorAll(".thumb.selected"), function (n) { n.classList.remove("selected"); });
  }

  function showRoot(kind) {
    F.root = kind; F.day = null; F.next = null; endSelect(); setTabs();
    $("btn-files-up").hidden = true;
    $("day-tools").hidden = true;
    $("btn-more").hidden = true;
    clear($("files-grid"));
    $("files-path").textContent = { shots: "Screenshots", recordings: "Recordings", keep: "Keep (never deleted automatically)" }[kind];
    $("files-msg").textContent = "Loading...";
    api.days(kind).then(function (d) {
      var ul = $("days-list");
      clear(ul);
      $("files-msg").textContent = d.days.length ? "" : "Nothing here yet.";
      d.days.forEach(function (x) {
        var li = el("li");
        var b = el("button", "day-button", x.day);
        b.type = "button";
        b.addEventListener("click", function () { showDay(x.day); });
        li.appendChild(b);
        li.appendChild(el("span", "small", x.files + " file(s) · " + L.formatBytes(x.bytes)));
        ul.appendChild(li);
      });
    }).catch(fail);
  }

  function showDay(day) {
    F.day = day; F.next = null; F.items = []; endSelect();
    clear($("days-list"));
    clear($("files-grid"));
    $("btn-files-up").hidden = false;
    $("day-tools").hidden = F.root === "keep";
    $("files-path").textContent = day;
    loadMore();
  }
  $("btn-more").addEventListener("click", loadMore);

  function loadMore() {
    $("files-msg").textContent = "Loading...";
    api.files(F.root, F.day, F.next, 60).then(function (f) {
      F.next = f.next;
      $("btn-more").hidden = !f.next;
      $("files-msg").textContent = "";
      f.files.forEach(addTile);
    }).catch(fail);
  }

  function addTile(x) {
    F.items.push(x);
    var p = L.parseShotName(x.name);
    var b = el("button", "thumb");
    b.type = "button";
    b.setAttribute("data-key", x.key);
    if (/\.mov$/.test(x.name)) {
      b.appendChild(el("span", "video-label", "Recording " + L.formatBytes(x.bytes)));
    } else {
      var img = el("img");
      img.loading = "lazy";
      img.alt = x.name;
      img.src = api.imgUrl(x.thumb || x.key);
      b.appendChild(img);
    }
    b.appendChild(el("span", "", (p.time || x.name) + (p.reason ? " · " + p.reason : "")));
    var pressTimer = null, longPressed = false;
    b.addEventListener("pointerdown", function () {
      longPressed = false;
      pressTimer = setTimeout(function () { longPressed = true; startSelect(); toggle(b, x); }, 550);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) { b.addEventListener(ev, function () { clearTimeout(pressTimer); }); });
    b.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    b.addEventListener("click", function () {
      if (longPressed) { longPressed = false; return; }
      if (F.selecting) toggle(b, x); else openViewer(x);
    });
    $("files-grid").appendChild(b);
  }

  function startSelect() {
    F.selecting = true;
    $("select-bar").hidden = false;
    $("btn-select").textContent = "Done";
    $("btn-sel-keep").hidden = F.root === "keep";
    updateSelCount();
  }
  function toggle(node, x) {
    if (F.selected[x.key]) { delete F.selected[x.key]; node.classList.remove("selected"); }
    else { F.selected[x.key] = x; node.classList.add("selected"); }
    updateSelCount();
  }
  function selectedList() { return Object.keys(F.selected).map(function (k) { return F.selected[k]; }); }
  function updateSelCount() { $("select-count").textContent = selectedList().length + " selected"; }
  $("btn-select").addEventListener("click", function () { if (F.selecting) endSelect(); else startSelect(); });
  $("btn-sel-cancel").addEventListener("click", endSelect);

  $("btn-sel-download").addEventListener("click", function () {
    var list = selectedList();
    if (!list.length) return;
    // one at a time through the browser (no server-side zip)
    list.forEach(function (x, i) {
      setTimeout(function () {
        var a = el("a"); a.href = api.dlUrl(x.key); a.download = x.name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      }, i * 900);
    });
    toast("Downloading " + list.length + " file(s), one by one.");
  });
  $("btn-sel-keep").addEventListener("click", function () {
    var keys = selectedList().map(function (x) { return x.key; });
    if (!keys.length) return;
    keepKeys(keys).then(function () { endSelect(); showDay(F.day); });
  });
  $("btn-sel-delete").addEventListener("click", function () {
    var keys = selectedList().map(function (x) { return x.key; });
    if (!keys.length) return;
    purgeFlow({ mode: "keys", keys: keys }, function () { endSelect(); showDay(F.day); });
  });

  function keepKeys(keys) {
    var chunks = [];
    for (var i = 0; i < keys.length; i += 10) chunks.push(keys.slice(i, i + 10));
    var kept = 0, failed = 0;
    return chunks.reduce(function (p, c) {
      return p.then(function () { return api.keep(c).then(function (r) { kept += r.kept.length; failed += r.failed.length; }); });
    }, Promise.resolve()).then(function () {
      toast("Kept " + kept + (failed ? ", " + failed + " failed (try again)" : "") + ". Find them under Keep.", failed > 0);
    }).catch(fail);
  }

  // dry run -> confirm with the numbers -> delete in batches until done
  function purgeFlow(body, done) {
    var dry = Object.assign({}, body, { dryRun: true });
    api.purge(dry).then(function (r) {
      if (!r.files) { toast("Nothing to delete."); return; }
      ask("Delete " + r.files + " file(s), " + L.formatBytes(r.bytes) + "? This cannot be undone.", "Delete", function () {
        var total = 0;
        var step = function () {
          return api.purge(Object.assign({}, body, { dryRun: false })).then(function (x) {
            total += x.deleted;
            $("purge-msg").textContent = "Deleted " + total + " of " + r.files + "...";
            if (x.more && x.deleted > 0) return step();
          });
        };
        step().then(function () {
          $("purge-msg").textContent = "Deleted " + total + " file(s).";
          toast("Deleted " + total + " file(s).");
          if (done) done();
        }).catch(fail);
      });
    }).catch(fail);
  }
  $("btn-purge-day").addEventListener("click", function () {
    if (!F.day) return;
    purgeFlow({ mode: "day", day: F.day, kinds: F.root === "recordings" ? ["recordings"] : ["shots"] }, function () { showRoot(F.root); });
  });
  $("btn-purge-preview").addEventListener("click", function () {
    var d = parseInt($("purge-days").value, 10);
    if (!(d >= 1 && d <= 3650)) { toast("Enter a number of days from 1 to 3650.", true); return; }
    purgeFlow({ mode: "olderThanDays", days: d }, function () { showRoot(F.root); });
  });

  // ------------------------------------------------------------- viewer ---
  var viewing = null;
  function openViewer(x) {
    viewing = x;
    var isVideo = /\.mov$/.test(x.name);
    var img = $("viewer-img"), vid = $("viewer-video");
    img.hidden = isVideo; vid.hidden = !isVideo;
    if (isVideo) { img.removeAttribute("src"); vid.src = api.imgUrl(x.key); }
    else { vid.removeAttribute("src"); img.src = api.imgUrl(x.key); img.alt = x.name; }
    var p = L.parseShotName(x.name);
    $("viewer-meta").textContent = (p.date ? p.date + " " + p.time + " · " + p.reason + " · " : x.name + " · ") + L.formatBytes(x.bytes);
    $("viewer-download").href = api.dlUrl(x.key);
    $("viewer-download").setAttribute("download", x.name);
    $("viewer-keep").hidden = !/^(shots|recordings)\//.test(x.key);
    $("viewer").showModal();
  }
  function closeViewer() { $("viewer-video").pause(); $("viewer").close(); }
  $("viewer-close").addEventListener("click", closeViewer);
  $("viewer-keep").addEventListener("click", function () {
    if (!viewing) return;
    keepKeys([viewing.key]).then(function () { closeViewer(); if (F.day) showDay(F.day); });
  });
  $("viewer-delete").addEventListener("click", function () {
    if (!viewing) return;
    var x = viewing;
    closeViewer();
    purgeFlow({ mode: "keys", keys: [x.key] }, function () { if (F.day) showDay(F.day); loadLatest(); });
  });

  // ------------------------------------------------------------ storage ---
  function startStorage() {
    loadStorage();
    every(30000, loadStorage);
  }
  function loadStorage() {
    return api.storage().then(function (s) {
      meter($("storage-meter-bar"), s);
      $("storage-used").textContent = L.formatBytes(s.usedBytes) + " used of " + L.formatBytes(s.freeBytes) +
        " (" + Math.round(s.fraction * 100) + " %)";
      $("storage-growth").textContent = "Growing about " + L.formatBytes(s.avgPerDay) + " per day (last 7 days). " +
        (s.daysUntilSoftLimit !== null ? "At that rate the storage guard (" + L.formatBytes(s.softLimitBytes) + ") starts deleting the oldest days in about " + s.daysUntilSoftLimit + " days." : "");
      dl($("storage-kinds"), ["shots", "thumbs", "recordings", "keep", "live"].map(function (k) {
        var x = s.byKind[k] || { files: 0, bytes: 0 };
        return [k, x.files + " file(s) · " + L.formatBytes(x.bytes)];
      }));
      var bars = $("storage-days");
      clear(bars);
      var max = Math.max.apply(null, s.perDay.map(function (x) { return x.bytes; }).concat([1]));
      s.perDay.forEach(function (x) {
        var row = el("div", "bar-row");
        row.appendChild(el("span", "bar-label", x.day.slice(5)));
        var track = el("span", "bar-track");
        var fill = el("span", "bar-fill");
        fill.style.width = Math.round(x.bytes / max * 100) + "%";
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(el("span", "bar-value", L.formatBytes(x.bytes)));
        bars.appendChild(row);
      });
      var m = s.mac || {};
      dl($("storage-mac"), [
        ["Free disk", m.diskFreeGB !== null && m.diskFreeGB !== undefined ? m.diskFreeGB + " GB" : "unknown"],
        ["Waiting to upload", m.queueFiles !== null && m.queueFiles !== undefined ? m.queueFiles + " file(s), " + m.queueMB + " MB" : "unknown"],
        ["As of", m.updated ? L.ageString(s.now - m.updated) + " ago" : "no status yet"]
      ]);
      var u = s.usage;
      var lvl = function (a, b) { return a / b >= 0.8 ? "warn" : ""; };
      dl($("storage-usage"), [
        ["Worker requests", "about " + u.workerRequests + " of " + u.workerLimit, lvl(u.workerRequests, u.workerLimit)],
        ["B2 downloads", "about " + u.b2Downloads + " of " + u.b2DownloadLimit, lvl(u.b2Downloads, u.b2DownloadLimit)]
      ]);
      var notes = [];
      if (s.guard) notes.push("Storage guard last deleted " + s.guard.deleted + " file(s) (" + s.guard.days.join(", ") + ").");
      if (s.reconcile) notes.push("Checked against Backblaze " + L.ageString(s.now - s.reconcile.t) + " ago: " + s.reconcile.files + " file(s)" + (s.reconcile.complete ? "" : " (partial)") + ".");
      notes.push("Counters are sampled estimates.");
      $("storage-notes").textContent = notes.join(" ");
    }).catch(fail);
  }

  // ----------------------------------------------------------- settings ---
  function startSettings() {
    api.settings().then(function (r) {
      var box = $("settings-fields");
      clear(box);
      r.table.forEach(function (s) {
        var id = "set-" + s.key;
        var lab = el("label", "", s.label);
        lab.htmlFor = id;
        var inp = el("input");
        inp.id = id; inp.type = "number"; inp.min = s.min; inp.max = s.max; inp.step = 1; inp.inputMode = "numeric";
        inp.placeholder = "default " + s.def;
        if (Object.prototype.hasOwnProperty.call(r.values, s.key)) inp.value = r.values[s.key];
        box.appendChild(lab);
        box.appendChild(inp);
        box.appendChild(el("p", "small", s.min + " to " + s.max + (s.help ? ". " + s.help : "") + (s.worker ? " (on the server)" : "")));
      });
    }).catch(fail);
  }
  function collect() {
    var v = {};
    L.SETTINGS.forEach(function (s) { var i = $("set-" + s.key); if (i && i.value !== "") v[s.key] = i.value; });
    return v;
  }
  $("settings-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var local = L.validateSettings(collect());
    if (local.errors.length) { $("settings-msg").textContent = local.errors.join("; "); return; }
    api.saveSettings(local.values).then(function () {
      $("settings-msg").textContent = "Saved. The Mac picks it up within 20 seconds (2 while this page is open).";
    }).catch(function (e2) { $("settings-msg").textContent = (e2.details && e2.details.join("; ")) || e2.message; });
  });
  $("btn-settings-reset").addEventListener("click", function () {
    api.saveSettings({}).then(function () { startSettings(); $("settings-msg").textContent = "Cleared: the Mac uses its config.env again."; }).catch(fail);
  });

  route();
})();
