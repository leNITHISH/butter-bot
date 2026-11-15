/* mac-watch gallery: a full-screen viewer for screenshots and recordings.
   Swipe or arrow keys to move, pinch / double-tap / wheel to zoom, drag to pan, swipe down
   or Back or Esc to close, tap to hide the bars, true full screen where the browser allows it.
   No library and no HTML strings: every node is built with createElement and filled with textContent.
   The item list is shared with the page and can grow while open (loadMore). */
(function (root) {
  "use strict";

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function button(cls, text, label) {
    var b = el("button", cls, text);
    b.type = "button";
    if (label) b.setAttribute("aria-label", label);
    return b;
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  var isVideo = function (it) { return /\.mov$/i.test(it.name || it.key); };
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function fsSupported(node) { return !!(node.requestFullscreen || node.webkitRequestFullscreen); }
  function fsEnter(node) { var f = node.requestFullscreen || node.webkitRequestFullscreen; if (f) { try { var r = f.call(node); if (r && r.catch) r.catch(function () {}); } catch (e) { /* not allowed */ } } }
  function fsExit() { var f = document.exitFullscreen || document.webkitExitFullscreen; if (f && fsElement()) { try { var r = f.call(document); if (r && r.catch) r.catch(function () {}); } catch (e) { /* ignore */ } } }

  // opts: imgUrl(key), dlUrl(key), parseName(name) -> {date,time,reason}, formatBytes(n),
  //       reasonTag(reason) -> node, loadMore() -> Promise<bool>, canKeep(item), onKeep(item) -> Promise<bool>,
  //       onDelete(item) -> Promise<bool>
  function create(opts) {
    var items = [], index = 0, open = false, pushed = false;
    var W = 0, H = 0;
    // zoom state of the current panel
    var s = 1, tx = 0, ty = 0, fitW = 0, fitH = 0, maxS = 5;
    var chrome = true;

    // ---------------------------------------------------------------- DOM --
    var g = el("div", "gal");
    g.hidden = true;
    g.setAttribute("role", "dialog");
    g.setAttribute("aria-modal", "true");
    g.setAttribute("aria-label", "Screenshot viewer");
    g.tabIndex = -1;
    var stage = el("div", "gal-stage");
    var track = el("div", "gal-track");
    var panels = [el("div", "gal-panel"), el("div", "gal-panel"), el("div", "gal-panel")];
    panels.forEach(function (p) { track.appendChild(p); });
    stage.appendChild(track);
    g.appendChild(stage);

    var top = el("div", "gal-bar gal-top");
    var count = el("span", "gal-count");
    var when = el("span", "gal-when");
    var reasonBox = el("span", "gal-reason");
    var closeBtn = button("link gal-close", "close", "Close the viewer");
    top.appendChild(count); top.appendChild(when); top.appendChild(reasonBox); top.appendChild(closeBtn);
    g.appendChild(top);

    var bottom = el("div", "gal-bar gal-bottom");
    var prevBtn = button("link gal-nav", "newer", "Newer screenshot");
    var nextBtn = button("link gal-nav", "older >", "Older screenshot");
    var dlA = el("a", "button primary", "download");
    var keepBtn = button("", "keep");
    var delBtn = button("danger", "delete");
    var zoomBtn = button("gal-zoom", "zoom", "Zoom in or back to fit");
    var fsBtn = button("", "full screen");
    var infoBtn = button("", "info");
    [prevBtn, dlA, keepBtn, delBtn, zoomBtn, fsBtn, infoBtn, nextBtn].forEach(function (n) { bottom.appendChild(n); });
    g.appendChild(bottom);

    var info = el("dl", "gal-info");
    info.hidden = true;
    g.appendChild(info);
    var note = el("p", "gal-note");
    note.hidden = true;
    g.appendChild(note);

    document.body.appendChild(g);

    // ------------------------------------------------------------ panels --
    function cur() { return panels[1]; }
    function media(p) { return p.firstChild; }

    function fill(p, it, full) {
      while (p.firstChild) p.removeChild(p.firstChild);
      p.removeAttribute("data-key");
      if (!it) return;
      p.setAttribute("data-key", it.key);
      if (isVideo(it)) {
        var v = el("video", "gal-media");
        v.controls = true; v.playsInline = true; v.preload = "metadata";
        if (full) v.src = opts.imgUrl(it.key);
        p.appendChild(v);
        return;
      }
      var img = el("img", "gal-media");
      img.alt = it.name || "";
      img.draggable = false;
      img.decoding = "async";
      // the thumbnail is already cached by the grid: show it at once, swap in the full shot
      img.src = opts.imgUrl(it.thumb || it.key);
      p.appendChild(img);
      if (full) upgrade(p, it);
    }
    function upgrade(p, it) {
      var m = media(p);
      if (!m || m.tagName !== "IMG" || !it || p.getAttribute("data-key") !== it.key) return;
      if (isVideo(it) || m.getAttribute("data-full") === "1") return;
      var full = opts.imgUrl(it.key);
      if (!it.thumb) { m.setAttribute("data-full", "1"); return; }
      var pre = new Image();
      pre.onload = function () {
        if (p.getAttribute("data-key") === it.key) { m.src = full; m.setAttribute("data-full", "1"); measure(); }
      };
      pre.src = full;
    }

    function render() {
      fill(panels[0], items[index - 1], false);
      fill(panels[1], items[index], true);
      fill(panels[2], items[index + 1], false);
      resetZoom();
      setTrack(0, false);
      header();
      // neighbours get their full image a moment later, so a swipe lands on a sharp picture
      clearTimeout(render.t);
      render.t = setTimeout(function () { upgrade(panels[0], items[index - 1]); upgrade(panels[2], items[index + 1]); }, 500);
      if (index >= items.length - 3 && opts.loadMore) opts.loadMore().then(function (added) { if (added && open) { fill(panels[2], items[index + 1], false); header(); } });
    }

    function header() {
      var it = items[index];
      if (!it) return;
      var p = opts.parseName(it.name || "");
      count.textContent = pad2(index + 1) + " / " + pad2(items.length) + (opts.hasMore && opts.hasMore() ? "+" : "");
      while (when.firstChild) when.removeChild(when.firstChild);
      if (p.date) { when.appendChild(el("span", "gal-date", p.date + " ")); when.appendChild(el("span", "", p.time)); }
      else when.textContent = it.name;
      while (reasonBox.firstChild) reasonBox.removeChild(reasonBox.firstChild);
      if (p.reason) reasonBox.appendChild(opts.reasonTag(p.reason));
      dlA.href = opts.dlUrl(it.key);
      dlA.setAttribute("download", it.name || "");
      keepBtn.hidden = !opts.canKeep(it);
      zoomBtn.hidden = isVideo(it);
      fsBtn.hidden = !fsSupported(g);
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index >= items.length - 1 && !(opts.hasMore && opts.hasMore());
      if (!info.hidden) fillInfo();
    }

    function fillInfo() {
      var it = items[index];
      var p = opts.parseName(it.name || "");
      while (info.firstChild) info.removeChild(info.firstChild);
      [["file", it.name], ["taken", p.date ? p.date + " " + p.time : "?"], ["reason", p.reason || "?"],
       ["size", opts.formatBytes(it.bytes)], ["stored as", it.key]].forEach(function (r) {
        var d = el("div");
        d.appendChild(el("dt", "", r[0]));
        d.appendChild(el("dd", "", String(r[1])));
        info.appendChild(d);
      });
    }

    // ------------------------------------------------------------ zoom ----
    function layout() {
      stage.style.top = chrome ? top.offsetHeight + "px" : "0";
      stage.style.bottom = chrome ? bottom.offsetHeight + "px" : "0";
    }
    function measure() {
      layout();
      var r = stage.getBoundingClientRect();
      W = r.width; H = r.height;
      var m = media(cur());
      if (!m || m.tagName !== "IMG") { fitW = W; fitH = H; return; }
      var nw = m.naturalWidth || W, nh = m.naturalHeight || H;
      var k = Math.min(W / nw, H / nh);
      fitW = nw * k; fitH = nh * k;
      // enough to see real pixels and then some
      maxS = Math.max(4, (m.getAttribute("data-full") === "1" ? nw / fitW : 1) * 2);
    }
    function apply() {
      var m = media(cur());
      if (!m || m.tagName !== "IMG") return;
      m.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + s + ")";
      zoomBtn.textContent = s > 1.01 ? "fit" : "zoom";
      g.classList.toggle("zoomed", s > 1.01);
    }
    function clampPan() {
      var mx = Math.max(0, (fitW * s - W) / 2), my = Math.max(0, (fitH * s - H) / 2);
      tx = clamp(tx, -mx, mx); ty = clamp(ty, -my, my);
    }
    function resetZoom() { s = 1; tx = 0; ty = 0; measure(); apply(); }
    // zoom to scale ns keeping the point (px, py) (relative to the stage centre) still
    function zoomAt(px, py, ns) {
      ns = clamp(ns, 1, maxS);
      tx = px - (px - tx) * (ns / s);
      ty = py - (py - ty) * (ns / s);
      s = ns;
      if (s <= 1.001) { s = 1; tx = 0; ty = 0; }
      clampPan(); apply();
    }
    function rel(e) {
      var r = stage.getBoundingClientRect();
      return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
    }

    // ------------------------------------------------------------ moving --
    function setTrack(dx, animate) {
      track.style.transition = animate && !reduceMotion ? "transform 180ms ease-out" : "none";
      track.style.transform = "translateX(calc(-100% + " + dx + "px))";
    }
    var moving = false, queued = 0;
    function go(delta) {
      if (!open) return;
      if (moving) { queued += delta; return; }       // fast key presses / taps: do them in order
      var to = index + delta;
      if (to < 0) { bounce(); return; }
      if (to >= items.length) {
        if (opts.hasMore && opts.hasMore() && opts.loadMore) {
          opts.loadMore().then(function (added) { if (added) go(delta); else bounce(); });
        } else bounce();
        return;
      }
      pauseVideos();
      moving = true;
      var done = function () {
        track.removeEventListener("transitionend", done);
        clearTimeout(done.t);
        if (!moving) return;
        moving = false;
        index = to;
        // rotate the panels instead of reloading: the new current one is already on screen
        if (delta > 0) { track.appendChild(panels[0]); panels.push(panels.shift()); fill(panels[2], items[index + 1], false); }
        else { track.insertBefore(panels[2], panels[0]); panels.unshift(panels.pop()); fill(panels[0], items[index - 1], false); }
        var c = cur();
        if (isVideo(items[index]) && media(c) && !media(c).src) media(c).src = opts.imgUrl(items[index].key);
        upgrade(c, items[index]);
        resetZoom();
        setTrack(0, false);
        header();
        clearTimeout(render.t);
        render.t = setTimeout(function () { upgrade(panels[0], items[index - 1]); upgrade(panels[2], items[index + 1]); }, 400);
        if (index >= items.length - 3 && opts.loadMore) opts.loadMore().then(function (added) { if (added && open) { fill(panels[2], items[index + 1], false); header(); } });
        if (queued) { var d = queued > 0 ? 1 : -1; queued -= d; go(d); }
      };
      if (reduceMotion) { setTrack(delta > 0 ? -W : W, false); done(); return; }
      track.addEventListener("transitionend", done);
      done.t = setTimeout(done, 260);
      setTrack(delta > 0 ? -W : W, true);
    }
    function bounce() { queued = 0; setTrack(0, true); }
    function pauseVideos() { panels.forEach(function (p) { var m = media(p); if (m && m.tagName === "VIDEO") m.pause(); }); }

    // ------------------------------------------------------------ gestures --
    var pts = {}, mode = null, start = null, lastTap = null, tapTimer = null;
    function npts() { return Object.keys(pts).length; }
    function two() { var k = Object.keys(pts); return [pts[k[0]], pts[k[1]]]; }
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function mid(a, b) { return { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }; }

    stage.addEventListener("pointerdown", function (e) {
      if (e.target.tagName === "VIDEO") return;            // let the video controls work
      if (e.pointerType === "mouse" && e.button !== 0) return;
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or already released */ }
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (npts() === 1) {
        mode = null;
        start = { x: e.clientX, y: e.clientY, t: Date.now(), tx: tx, ty: ty, moved: false };
      } else if (npts() === 2) {
        var p = two();
        mode = "pinch";
        start = { d: dist(p[0], p[1]) || 1, s: s, tx: tx, ty: ty, m: rel(mid(p[0], p[1])), moved: true };
      }
    });
    stage.addEventListener("pointermove", function (e) {
      if (!pts[e.pointerId] || !start) return;
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (mode === "pinch" && npts() >= 2) {
        var p = two();
        var m = rel(mid(p[0], p[1]));
        var ns = clamp(start.s * dist(p[0], p[1]) / start.d, 1, maxS);
        // keep the picture point under the first midpoint under the fingers
        tx = m.x - (start.m.x - start.tx) * (ns / start.s);
        ty = m.y - (start.m.y - start.ty) * (ns / start.s);
        s = ns; clampPan(); apply();
        return;
      }
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) > 8) {
        start.moved = true;
        if (s > 1.01) mode = "pan";
        else if (Math.abs(dx) > Math.abs(dy)) mode = "swipe";
        else if (dy > 0) mode = "pull";
        else mode = "none";
      }
      if (mode === "pan") { tx = start.tx + dx; ty = start.ty + dy; clampPan(); apply(); }
      else if (mode === "swipe") { setTrack(dx, false); }
      else if (mode === "pull") {
        var mm = media(cur());
        if (mm) mm.style.transform = "translateY(" + Math.max(0, dy) + "px)";
        g.style.setProperty("--gal-dim", String(clamp(1 - dy / 400, 0.3, 1)));
      }
    });
    function end(e) {
      if (!pts[e.pointerId]) return;
      delete pts[e.pointerId];
      if (mode === "pinch") {
        if (npts() === 0) { if (s < 1.03) resetZoom(); mode = null; start = null; }
        else { var k = Object.keys(pts)[0]; start = { x: pts[k].x, y: pts[k].y, t: Date.now(), tx: tx, ty: ty, moved: true }; mode = "pan"; }
        return;
      }
      if (!start) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y, dt = Math.max(1, Date.now() - start.t);
      if (mode === "swipe") {
        if (Math.abs(dx) > W * 0.18 || Math.abs(dx) / dt > 0.45) go(dx < 0 ? 1 : -1); else bounce();
      } else if (mode === "pull") {
        g.style.removeProperty("--gal-dim");
        if (dy > 110) close(); else { var mm = media(cur()); if (mm) mm.style.transform = ""; apply(); }
      } else if (!start.moved && e.type === "pointerup") {
        tap(e);
      }
      mode = null; start = null;
    }
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);

    function tap(e) {
      var now = Date.now();
      if (lastTap && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        clearTimeout(tapTimer); lastTap = null;
        var p = rel(e);
        if (s > 1.01) resetZoom(); else zoomAt(p.x, p.y, Math.min(2.5, maxS));
        return;
      }
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      clearTimeout(tapTimer);
      tapTimer = setTimeout(function () { lastTap = null; setChrome(!chrome); }, 300);
    }
    function setChrome(on) {
      chrome = on; g.classList.toggle("bare", !on);
      var ow = fitW;
      measure();
      // keep the zoom where it was, scaled to the new picture size
      if (ow && s > 1) { tx *= fitW / ow; ty *= fitW / ow; }
      clampPan(); apply();
    }

    stage.addEventListener("wheel", function (e) {
      if (!open) return;
      e.preventDefault();
      if (isVideo(items[index] || {})) return;
      var p = rel(e);
      var factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
      zoomAt(p.x, p.y, s * factor);
    }, { passive: false });

    // ------------------------------------------------------------ buttons --
    closeBtn.addEventListener("click", function () { close(); });
    prevBtn.addEventListener("click", function () { go(-1); });
    nextBtn.addEventListener("click", function () { go(1); });
    zoomBtn.addEventListener("click", function () { if (s > 1.01) resetZoom(); else zoomAt(0, 0, Math.min(2.5, maxS)); });
    fsBtn.addEventListener("click", function () { if (fsElement()) fsExit(); else fsEnter(g); });
    infoBtn.addEventListener("click", function () { info.hidden = !info.hidden; if (!info.hidden) fillInfo(); });
    keepBtn.addEventListener("click", function () { act(opts.onKeep, "Kept. It is under Keep now."); });
    delBtn.addEventListener("click", function () { act(opts.onDelete, "Deleted."); });
    function onFs() { fsBtn.textContent = fsElement() ? "exit full screen" : "full screen"; setTimeout(function () { measure(); clampPan(); apply(); }, 50); }
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    window.addEventListener("resize", function () { if (open) { measure(); clampPan(); apply(); } });

    // keep / delete: the page does the work (and asks before deleting); the item leaves the list
    function act(fn, msg) {
      var it = items[index];
      if (!it || !fn) return;
      fn(it).then(function (removed) {
        if (!removed || !open) return;
        var i = items.indexOf(it);
        if (i >= 0) items.splice(i, 1);
        flash(msg);
        if (!items.length) { close(); return; }
        index = Math.min(index, items.length - 1);
        render();
      });
    }
    var flashT = null;
    function flash(msg) {
      note.textContent = msg; note.hidden = false;
      clearTimeout(flashT); flashT = setTimeout(function () { note.hidden = true; }, 2200);
    }

    document.addEventListener("keydown", function (e) {
      if (!open || e.defaultPrevented) return;
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (document.querySelector("dialog[open]")) return;   // a confirm is up
      var k = e.key;
      if (k === "ArrowRight") { go(1); e.preventDefault(); }
      else if (k === "ArrowLeft") { go(-1); e.preventDefault(); }
      else if (k === "Escape") { if (!fsElement()) close(); }
      else if (k === "+" || k === "=") zoomAt(0, 0, s * 1.5);
      else if (k === "-") zoomAt(0, 0, s / 1.5);
      else if (k === "0") resetZoom();
      else if (k === "f") fsBtn.click();
      else if (k === "i") infoBtn.click();
    });

    // Back button closes the viewer instead of leaving the page
    window.addEventListener("popstate", function () { if (open) { pushed = false; doClose(); } });

    // ------------------------------------------------------------ open/close --
    function openAt(list, i) {
      items = list;
      index = clamp(i, 0, Math.max(0, items.length - 1));
      if (!items.length) return;
      open = true;
      g.hidden = false;
      document.documentElement.classList.add("gal-open");
      setChrome(true);
      info.hidden = true;
      if (!pushed) {
        // the page restores its own scroll position (onto the picture last viewed), not the browser
        try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) { /* ignore */ }
        try { history.pushState({ mwGallery: 1 }, ""); pushed = true; } catch (e) { pushed = false; }
      }
      render();
      requestAnimationFrame(function () { measure(); apply(); });
      g.focus({ preventScroll: true });
    }
    function doClose() {
      if (!open) return;
      open = false;
      pauseVideos();
      fsExit();
      g.hidden = true;
      document.documentElement.classList.remove("gal-open");
      panels.forEach(function (p) { while (p.firstChild) p.removeChild(p.firstChild); });
      var last = items[index];
      if (opts.onClose) setTimeout(function () { opts.onClose(last); }, 0);
    }
    function close() {
      if (pushed) { pushed = false; history.back(); }   // popstate is ignored now (pushed=false), so close here
      doClose();
    }

    return { open: openAt, close: close, isOpen: function () { return open; },
             refresh: function () { if (open) header(); } };
  }

  var api = { create: create };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MacWatchGallery = api;
})(typeof self !== "undefined" ? self : this);
