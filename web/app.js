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
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  // a Tag in the reason's accent (interval, space, enter, remote, wake, lock...)
  function reasonTag(reason) {
    var safe = /^[a-z0-9-]+$/.test(reason || "") ? reason : "other";
    return el("span", "tag r-" + safe, safe);
  }
  // decorative barcode generated from a name (the design system's Barcode)
  function barcode(node, text) {
    clear(node);
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      [c & 3, (c >> 2) & 3, (c >> 4) & 3].forEach(function (w, j) {
        var bar = el("i");
        bar.style.width = (w + 1) + "px";
        bar.style.marginRight = ((c >> j) & 1 ? 2 : 3) + "px";
        node.appendChild(bar);
      });
    }
  }
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

  // label/value tiles: rows of [label, value, class ("warn", "bad", "wide")]
  function dl(target, rows) {
    clear(target);
    rows.forEach(function (r) {
      if (r[1] === undefined || r[1] === null || r[1] === "") return;
      var tile = el("div", "tile" + (r[2] ? " " + r[2] : ""));
      tile.appendChild(el("dt", "", r[0]));
      tile.appendChild(el("dd", "", String(r[1])));
      target.appendChild(tile);
    });
  }

  // ------------------------------------------------------------ confirm ---
  var confirmCb = null, confirmNo = null;
  function ask(text, yesLabel, cb, no) {
    $("confirm-text").textContent = text;
    $("confirm-yes").textContent = yesLabel || "delete";
    confirmCb = cb; confirmNo = no || null;
    $("confirm").showModal();
  }
  function answer(yes) {
    var c = yes ? confirmCb : confirmNo;
    confirmCb = null; confirmNo = null;
    if (c) c();
  }
  $("confirm-yes").addEventListener("click", function () { $("confirm").close(); answer(true); });
  $("confirm-no").addEventListener("click", function () { $("confirm").close(); answer(false); });
  $("confirm").addEventListener("cancel", function () { answer(false); });   // Esc

  // ------------------------------------------------------------ screens ---
  var SCREENS = ["home", "files", "storage", "settings"];
  var current = null;
  var timers = [];
  function stopTimers() { timers.forEach(clearInterval); timers = []; }
  function every(ms, fn) { timers.push(setInterval(function () { if (!document.hidden) fn(); }, ms)); }

  function showSignIn() {
    stopTimers();
    $("nav").hidden = true;
    $("tabbar").hidden = true;
    $("btn-signout").hidden = true;
    SCREENS.forEach(function (s) { $("screen-" + s).hidden = true; });
    $("screen-signin").hidden = false;
    current = "signin";
    barcode($("barcode"), "mac-watch // owner only");
    api.config().then(function (cfg) {
      if (!cfg.configured || !cfg.clientId) {
        $("signin-msg").textContent = "Sign-in is not set up yet: ./worker/put-secrets.sh needs the Google Client ID, your e-mail and a session secret.";
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
    $("signin-msg").textContent = "checking";
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
      $("tabbar").hidden = false;
      Array.prototype.forEach.call($("tabbar").querySelectorAll("a"), function (a) {
        var on = a.getAttribute("data-screen") === name;
        a.className = on ? "active" : "";
        if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
      });
      $("btn-signout").hidden = false;
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
    loadRecent();
    loadHomeStorage();
    every(5000, function () { api.status().then(renderStatus).catch(fail); });
    every(30000, loadHomeStorage);
    every(3000, function () { if (lastStatus && lastStatus.live) loadLive(); });
  }

  function renderStatus(st) {
    lastStatus = st;
    var h = L.seenHealth(st.lastSeen, st.now);
    $("seen-dot").className = "pulse " + h.level;
    $("seen-text").textContent = h.text;
    var s = st.status || {};
    var paused = st.macPaused === "remote" ? "paused from this page (press Resume)" :
                 s.paused === "local" ? "paused with the PAUSE file on the Mac (cannot be lifted from here)" : "no";
    var lc = s.lastCapture || {};
    dl($("status-list"), [
      ["paused", paused, paused === "no" ? "" : "warn"],
      ["lid", s.lid],
      ["last shot", lc.epoch ? L.ageString(st.now - lc.epoch) + " ago · " + (lc.reason || "?") + " · " + (lc.result || "?") : "none yet"],
      ["battery", s.battery ? s.battery + " · " + (s.power || "?") : ""],
      ["waiting to upload", s.queue !== undefined ? s.queue + " file(s)" : ""],
      ["shot every", s.intervalSec ? s.intervalSec + " s" : ""],
      ["status from", s.updated ? L.ageString(st.now - s.updated) + " ago" : ""],
      ["polling", st.watching ? "every 2 s (this page is open)" : "every 20 s"],
      ["commands waiting", st.pendingCommands ? String(st.pendingCommands) : ""],
      ["errors", s.errors || "", "bad"]
    ]);
    $("btn-live").textContent = st.live ? "stop live view" : "live view";
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
        loadRecent(since).then(function (found) { if (found || n >= 20) clearInterval(t); });
      }, 2000);
    });
  });
  $("btn-record").addEventListener("click", function () {
    ask("Record the screen now? Length: settings > recording length, 5 minutes by default. macOS shows its recording indicator. Screen only, no sound.", "record", function () {
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

  // ---------------------------------------------------- recent shots carousel ---
  // The newest RECENT_N screenshots (across days), swipeable (CSS scroll-snap), with
  // arrows, dots, a counter and arrow keys. Tap a slide to open it full size.
  var RECENT_N = 12;
  var car = { items: [], index: 0, firstKey: null };

  function loadRecent(since) {
    return api.days("shots").then(function (d) {
      var items = [];
      var days = d.days.slice(0, 4);
      var next = function (i) {
        if (i >= days.length || items.length >= RECENT_N) return Promise.resolve(items);
        return api.files("shots", days[i].day, "", RECENT_N - items.length).then(function (f) {
          items = items.concat(f.files);
          return next(i + 1);
        });
      };
      return next(0);
    }).then(function (items) {
      if (!items.length) {
        $("carousel").hidden = true;
        clear($("car-dots"));
        $("car-meta").textContent = "No screenshots yet. Tap screenshot now.";
        return false;
      }
      if (items[0].key !== car.firstKey || items.length !== car.items.length) renderCarousel(items);
      return !since || items[0].uploaded >= since;
    }).catch(function (e) { fail(e); return false; });
  }

  function renderCarousel(items) {
    car.items = items;
    car.firstKey = items[0].key;
    var track = $("car-track"), dots = $("car-dots");
    clear(track); clear(dots);
    items.forEach(function (x, i) {
      var p = L.parseShotName(x.name);
      var slide = el("button", "slide");
      slide.type = "button";
      slide.setAttribute("aria-label", "Screenshot " + (p.date || "") + " " + (p.time || x.name) + ", open full size");
      var img = el("img");
      img.loading = i < 2 ? "eager" : "lazy";
      img.decoding = "async";
      img.alt = "";
      img.src = api.imgUrl(x.key);
      slide.appendChild(img);
      var cap = el("span", "slide-cap");
      cap.appendChild(el("span", "chip", p.time ? p.time.slice(0, 5) : x.name));
      if (p.reason) cap.appendChild(reasonTag(p.reason));
      slide.appendChild(cap);
      slide.addEventListener("click", function () { openGallery(car.items, i); });
      track.appendChild(slide);
      var dot = el("button");
      dot.type = "button";
      dot.setAttribute("aria-label", "Show screenshot " + (i + 1));
      dot.addEventListener("click", function () { carGo(i); });
      dots.appendChild(dot);
    });
    $("carousel").hidden = false;
    track.scrollLeft = 0;
    carSync(0);
  }

  function carSync(i) {
    car.index = i;
    var x = car.items[i];
    if (!x) return;
    var p = L.parseShotName(x.name);
    $("car-count").textContent = pad2(i + 1) + " / " + pad2(car.items.length);
    $("car-meta").textContent = (p.date ? p.date + " " + p.time : x.name) + " · " + (p.reason || "") + " · " + L.formatBytes(x.bytes) +
      (i === 0 ? " · newest" : "");
    Array.prototype.forEach.call($("car-dots").children, function (d, j) { d.className = j === i ? "on" : ""; });
    $("car-prev").disabled = i === 0;
    $("car-next").disabled = i === car.items.length - 1;
  }
  function carGo(i) {
    var track = $("car-track");
    i = Math.max(0, Math.min(car.items.length - 1, i));
    var slide = track.children[i];
    if (slide) track.scrollTo({ left: slide.offsetLeft - track.offsetLeft - parseFloat(getComputedStyle(track).paddingLeft || 0), behavior: "auto" });
    carSync(i);
  }
  var carTimer = null;
  $("car-track").addEventListener("scroll", function () {
    clearTimeout(carTimer);
    carTimer = setTimeout(function () {
      var track = $("car-track");
      var w = track.children[0] ? track.children[0].getBoundingClientRect().width + 10 : track.clientWidth;
      var i = Math.round(track.scrollLeft / w);
      if (i !== car.index) carSync(Math.max(0, Math.min(car.items.length - 1, i)));
    }, 60);
  });
  $("car-prev").addEventListener("click", function () { carGo(car.index - 1); });
  $("car-next").addEventListener("click", function () { carGo(car.index + 1); });
  $("car-track").addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") { e.preventDefault(); carGo(car.index - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); carGo(car.index + 1); }
  });

  function untilGuard(days) {
    if (days === null || days === undefined) return "";
    if (days > 730) return "years away at this rate";
    if (days > 60) return "about " + Math.round(days / 30) + " months away";
    return "about " + days + " days away";
  }
  function meter(bar, s) {
    bar.style.width = Math.min(100, Math.round(s.fraction * 1000) / 10) + "%";
    bar.className = s.level;
  }
  function loadHomeStorage() {
    return api.storage().then(function (s) {
      meter($("home-meter-bar"), s);
      $("home-storage-text").textContent = L.formatBytes(s.usedBytes) + " of " + L.formatBytes(s.freeBytes) + " free allowance" +
        (s.daysUntilSoftLimit !== null ? " · auto-cleanup " + untilGuard(s.daysUntilSoftLimit) : "");
    }).catch(fail);
  }

  // -------------------------------------------------------------- files ---
  // A timeline like a photo app: everything newest first under day headers, loaded as you
  // scroll. Tapping a picture opens the gallery on the same list, so swiping crosses days.
  var F = { root: "shots", days: [], dayIdx: 0, after: "", items: [], loading: null, gen: 0, selecting: false, selected: {} };
  var KIND_LABEL = { shots: "SCREENSHOTS", recordings: "RECORDINGS", keep: "KEEP" };

  function startFiles() { showRoot(F.root); }
  ["shots", "recordings", "keep"].forEach(function (k) {
    $("root-" + k).addEventListener("click", function () { showRoot(k); });
  });
  function setTabs() {
    ["shots", "recordings", "keep"].forEach(function (k) { $("root-" + k).className = k === F.root ? "tab active" : "tab"; });
  }
  function endSelect() {
    F.selecting = false; F.selected = {};
    $("select-bar").hidden = true;
    $("btn-select").textContent = "SELECT";
    Array.prototype.forEach.call(document.querySelectorAll(".thumb.selected"), function (n) { n.classList.remove("selected"); });
  }
  function dayLabel(day) {
    var d = new Date(day + "T12:00:00"), t = new Date();
    var diff = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    var o = { weekday: "short", day: "2-digit", month: "short" };
    if (d.getFullYear() !== t.getFullYear()) o.year = "numeric";
    var name = d.toLocaleDateString("en-GB", o).replace(",", "");
    return (diff === 0 ? "today · " : diff === 1 ? "yesterday · " : "") + name;
  }
  function hasMoreFiles() { return F.dayIdx < F.days.length; }

  function showRoot(kind) {
    F.gen++;
    F.root = kind; F.days = []; F.dayIdx = 0; F.after = ""; F.items = []; F.loading = null;
    endSelect(); setTabs();
    clear($("timeline"));
    $("btn-more").hidden = true;
    $("files-msg").textContent = "";
    $("files-path").textContent = KIND_LABEL[kind] + " // loading";
    var gen = F.gen;
    api.days(kind).then(function (d) {
      if (gen !== F.gen) return;
      F.days = d.days;
      var n = 0, b = 0;
      d.days.forEach(function (x) { n += x.files; b += x.bytes; });
      $("files-path").textContent = KIND_LABEL[kind] + " // " + n + " in " + d.days.length + " day" + (d.days.length === 1 ? "" : "s") + " · " + L.formatBytes(b);
      if (!d.days.length) {
        $("files-msg").textContent = kind === "keep" ? "Nothing kept yet. Open a screenshot and tap keep." : "Nothing here yet.";
        return;
      }
      fillScreen();
    }).catch(fail);
  }

  // keep loading while the end of the list is near the screen
  function fillScreen() {
    loadMoreFiles().then(function (added) {
      if (added && current === "files" && nearEnd()) fillScreen();
    });
  }
  function nearEnd() { return $("files-sentinel").getBoundingClientRect().top < window.innerHeight + 900; }

  // Loads the next page (60) of the current day, or the next day. Resolves true when it added
  // something (the gallery uses this to keep swiping past what is on screen).
  function loadMoreFiles() {
    if (F.loading) return F.loading;
    if (!hasMoreFiles()) return Promise.resolve(false);
    var gen = F.gen, day = F.days[F.dayIdx];
    $("files-msg").textContent = "loading";
    F.loading = api.files(F.root, day.day, F.after, 60).then(function (f) {
      if (gen !== F.gen) return false;
      var grid = daySection(day);
      f.files.forEach(function (x) { addTile(x, grid); });
      if (f.next) F.after = f.next; else { F.dayIdx++; F.after = ""; }
      $("files-msg").textContent = hasMoreFiles() ? "" : (F.items.length ? "That is everything." : "");
      $("btn-more").hidden = !hasMoreFiles();
      gallery.refresh();
      return f.files.length > 0 || hasMoreFiles();
    }).catch(function (e) { fail(e); return false; }).then(function (r) { if (gen === F.gen) F.loading = null; return r; });
    return F.loading;
  }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (es) {
      if (es[0].isIntersecting && current === "files") fillScreen();
    }, { rootMargin: "900px 0px" }).observe($("files-sentinel"));
  }
  $("btn-more").addEventListener("click", fillScreen);

  function daySection(day) {
    var found = $("timeline").querySelector('section[data-day="' + day.day + '"] .grid');
    if (found) return found;
    var sec = el("section", "day");
    sec.setAttribute("data-day", day.day);
    var head = el("p", "caption-line day-head");
    head.appendChild(el("span", "caption", dayLabel(day.day) + " // " + day.files + " · " + L.formatBytes(day.bytes)));
    if (F.root !== "keep") {
      var del = el("button", "caption caption-link link", "DELETE DAY");
      del.type = "button";
      del.addEventListener("click", function () {
        purgeFlow({ mode: "day", day: day.day, kinds: F.root === "recordings" ? ["recordings"] : ["shots"] }, function () { showRoot(F.root); });
      });
      head.appendChild(del);
    }
    sec.appendChild(head);
    var grid = el("div", "grid");
    sec.appendChild(grid);
    $("timeline").appendChild(sec);
    return grid;
  }

  function addTile(x, grid) {
    F.items.push(x);
    var p = L.parseShotName(x.name);
    var b = el("button", "thumb");
    b.type = "button";
    b.setAttribute("data-key", x.key);
    b.setAttribute("aria-label", (p.date ? p.date + " " + p.time : x.name) + (p.reason ? ", " + p.reason : "") + ", open");
    if (/\.mov$/.test(x.name)) {
      b.appendChild(el("span", "video-label", "recording · " + L.formatBytes(x.bytes)));
    } else {
      var img = el("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      img.src = api.imgUrl(x.thumb || x.key);
      b.appendChild(img);
    }
    var cap = el("span", "thumb-cap");
    cap.appendChild(el("span", "", p.time ? p.time.slice(0, 5) : x.name));
    if (p.reason) cap.appendChild(reasonTag(p.reason));
    b.appendChild(cap);
    var pressTimer = null, longPressed = false;
    b.addEventListener("pointerdown", function () {
      longPressed = false;
      pressTimer = setTimeout(function () { longPressed = true; if (!F.selecting) startSelect(); toggle(b, x); }, 550);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) { b.addEventListener(ev, function () { clearTimeout(pressTimer); }); });
    b.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    b.addEventListener("click", function () {
      if (longPressed) { longPressed = false; return; }
      if (F.selecting) toggle(b, x);
      else openGallery(F.items, F.items.indexOf(x), { loadMore: loadMoreFiles, hasMore: hasMoreFiles });
    });
    grid.appendChild(b);
  }
  function removeTile(key) {
    for (var i = 0; i < F.items.length; i++) if (F.items[i].key === key) { F.items.splice(i, 1); break; }
    var n = $("timeline").querySelector('.thumb[data-key="' + key + '"]');
    if (n) n.parentNode.removeChild(n);
  }

  function startSelect() {
    F.selecting = true;
    $("select-bar").hidden = false;
    $("btn-select").textContent = "DONE";
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
    keepKeys(keys).then(function () { endSelect(); showRoot(F.root); });
  });
  $("btn-sel-delete").addEventListener("click", function () {
    var keys = selectedList().map(function (x) { return x.key; });
    if (!keys.length) return;
    purgeFlow({ mode: "keys", keys: keys }, function () { endSelect(); showRoot(F.root); });
  });

  // resolves with the number kept
  function keepKeys(keys) {
    var chunks = [];
    for (var i = 0; i < keys.length; i += 10) chunks.push(keys.slice(i, i + 10));
    var kept = 0, failed = 0;
    return chunks.reduce(function (p, c) {
      return p.then(function () { return api.keep(c).then(function (r) { kept += r.kept.length; failed += r.failed.length; }); });
    }, Promise.resolve()).then(function () {
      toast("Kept " + kept + (failed ? ", " + failed + " failed (try again)" : "") + ". Find them under keep.", failed > 0);
      return kept;
    }).catch(function (e) { fail(e); return 0; });
  }

  // what the question calls the things being deleted
  function purgeNoun(body) {
    var kinds = body.mode === "keys" ? body.keys.map(function (k) { return k.split("/")[0]; }) : (body.kinds || ["shots", "recordings"]);
    var only = function (k) { return kinds.every(function (x) { return x === k; }); };
    return only("shots") ? "screenshot" : only("recordings") ? "recording" : "file";
  }

  // dry run -> confirm with the numbers -> delete in batches until done
  function purgeFlow(body, done, cancelled) {
    var dry = Object.assign({}, body, { dryRun: true });
    var no = function () { if (cancelled) cancelled(); };
    api.purge(dry).then(function (r) {
      if (!r.files) { toast("Nothing to delete."); no(); return; }
      var n = r.items !== undefined ? r.items : r.files;
      var noun = purgeNoun(body);
      ask("Delete " + n + " " + noun + (n === 1 ? "" : "s") + " (" + L.formatBytes(r.bytes) + (r.files > n ? ", with thumbnails" : "") + ")? This cannot be undone.", "delete", function () {
        var total = 0;
        var step = function () {
          return api.purge(Object.assign({}, body, { dryRun: false })).then(function (x) {
            total += x.deleted;
            $("purge-msg").textContent = "Deleted " + total + " of " + r.files + " files...";
            if (x.more && x.deleted > 0) return step();
          });
        };
        step().then(function () {
          $("purge-msg").textContent = "Deleted " + total + " file(s).";
          toast("Deleted " + total + " file(s).");
          if (done) done();
        }).catch(function (e) { fail(e); no(); });
      }, no);
    }).catch(function (e) { fail(e); no(); });
  }
  $("btn-purge-preview").addEventListener("click", function () {
    var d = parseInt($("purge-days").value, 10);
    if (!(d >= 1 && d <= 3650)) { toast("Enter a number of days from 1 to 3650.", true); return; }
    purgeFlow({ mode: "olderThanDays", days: d }, function () { showRoot(F.root); });
  });

  // ------------------------------------------------------------ gallery ---
  var galSource = {};
  var gallery = window.MacWatchGallery.create({
    imgUrl: api.imgUrl, dlUrl: api.dlUrl, parseName: L.parseShotName, formatBytes: L.formatBytes, reasonTag: reasonTag,
    loadMore: function () { return galSource.loadMore ? galSource.loadMore() : Promise.resolve(false); },
    hasMore: function () { return galSource.hasMore ? galSource.hasMore() : false; },
    canKeep: function (it) { return /^(shots|recordings)\//.test(it.key); },
    onKeep: function (it) {
      return keepKeys([it.key]).then(function (n) {
        if (n) { removeTile(it.key); refreshCar(); }
        return n > 0;
      });
    },
    onDelete: function (it) {
      return new Promise(function (resolve) {
        purgeFlow({ mode: "keys", keys: [it.key] }, function () { removeTile(it.key); refreshCar(); resolve(true); }, function () { resolve(false); });
      });
    },
    onClose: function (it) {
      // land the grid on the picture you were looking at
      if (!it || current !== "files") return;
      var n = $("timeline").querySelector('.thumb[data-key="' + it.key + '"]');
      if (n && n.scrollIntoView) n.scrollIntoView({ block: "center" });
    }
  });
  function openGallery(list, i, source) { galSource = source || {}; gallery.open(list, i); }
  function refreshCar() { car.firstKey = null; if (current === "home") loadRecent(); }

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
        (s.daysUntilSoftLimit !== null ? "The storage guard (" + L.formatBytes(s.softLimitBytes) + ", deletes the oldest days) is " + untilGuard(s.daysUntilSoftLimit) + "." : "");
      dl($("storage-kinds"), ["shots", "thumbs", "recordings", "keep", "live"].map(function (k) {
        var x = s.byKind[k] || { files: 0, bytes: 0 };
        return [k, x.files + " file(s) · " + L.formatBytes(x.bytes)];
      }));
      // columns standing on an orange baseline; today in orange
      var cols = $("storage-days");
      clear(cols);
      var labels = cols.nextElementSibling;
      if (!labels || labels.className !== "col-labels") {
        labels = el("div", "col-labels");
        cols.parentNode.insertBefore(labels, cols.nextSibling);
      }
      clear(labels);
      var max = Math.max.apply(null, s.perDay.map(function (x) { return x.bytes; }).concat([1]));
      s.perDay.forEach(function (x, i) {
        var c = el("div", "col" + (i === s.perDay.length - 1 ? " today" : ""));
        c.title = x.day + " · " + L.formatBytes(x.bytes);
        var bar = el("i");
        bar.style.height = Math.round(x.bytes / max * 100) + "%";
        c.appendChild(bar);
        cols.appendChild(c);
        labels.appendChild(el("span", "", x.day.slice(8)));
      });
      var m = s.mac || {};
      dl($("storage-mac"), [
        ["free disk", m.diskFreeGB !== null && m.diskFreeGB !== undefined ? m.diskFreeGB + " GB" : "unknown"],
        ["waiting to upload", m.queueFiles !== null && m.queueFiles !== undefined ? m.queueFiles + " file(s) · " + m.queueMB + " MB" : "unknown"],
        ["as of", m.updated ? L.ageString(s.now - m.updated) + " ago" : "no status yet"]
      ]);
      var u = s.usage;
      var lvl = function (a, b) { return a / b >= 0.8 ? "warn" : ""; };
      dl($("storage-usage"), [
        ["worker requests", "about " + u.workerRequests + " of " + u.workerLimit, lvl(u.workerRequests, u.workerLimit)],
        ["b2 downloads", "about " + u.b2Downloads + " of " + u.b2DownloadLimit, lvl(u.b2Downloads, u.b2DownloadLimit)]
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
        var field = el("div", "field");
        var lab = el("label", "", s.label);
        lab.htmlFor = id;
        var inp = el("input");
        inp.id = id; inp.type = "number"; inp.min = s.min; inp.max = s.max; inp.step = 1; inp.inputMode = "numeric";
        inp.placeholder = "default " + s.def;
        if (Object.prototype.hasOwnProperty.call(r.values, s.key)) inp.value = r.values[s.key];
        field.appendChild(lab);
        field.appendChild(inp);
        field.appendChild(el("p", "small", s.min + " to " + s.max + (s.help ? ". " + s.help : "") + (s.worker ? " (on the server)" : "")));
        box.appendChild(field);
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
