/* mac-watch dashboard: tiny Google Drive client (REST v3). Browser + node (tests inject fetch). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MacWatchDrive = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var API = "https://www.googleapis.com/drive/v3";
  var UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  var FOLDER = "application/vnd.google-apps.folder";

  function q(s) { return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"; }

  // opts: { fetch, getToken() -> string, rootName }
  function createDrive(opts) {
    var doFetch = opts.fetch;
    var ids = {};                      // path -> folder id cache

    function call(url, init) {
      init = init || {};
      init.headers = Object.assign({ Authorization: "Bearer " + opts.getToken() }, init.headers || {});
      return doFetch(url, init).then(function (r) {
        if (r.status === 401) { var e = new Error("Your Google sign-in expired. Sign in again."); e.code = 401; throw e; }
        if (!r.ok) return r.text().then(function (t) { var e = new Error("Drive " + r.status + ": " + String(t).slice(0, 200)); e.code = r.status; throw e; });
        return r;
      });
    }
    function json(url, init) { return call(url, init).then(function (r) { return r.json(); }); }

    function list(parentId, extraQ, extra) {
      extra = extra || {};
      var query = q(parentId) + " in parents and trashed = false" + (extraQ ? " and " + extraQ : "");
      var u = API + "/files?q=" + encodeURIComponent(query) +
        "&fields=" + encodeURIComponent("files(id,name,mimeType,modifiedTime,size)") +
        "&pageSize=" + (extra.pageSize || 100) +
        (extra.orderBy ? "&orderBy=" + encodeURIComponent(extra.orderBy) : "");
      return json(u).then(function (d) { return d.files || []; });
    }

    function findChild(parentId, name, mime) {
      var extra = "name = " + q(name) + (mime ? " and mimeType = " + q(mime) : "");
      return list(parentId, extra, { pageSize: 1 }).then(function (f) { return f[0] || null; });
    }

    function createFolder(parentId, name) {
      return json(API + "/files?fields=id,name", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, mimeType: FOLDER, parents: [parentId] })
      });
    }

    // "mac-watch/control" -> folder id (null if it does not exist and create is false)
    function folderId(path, create) {
      if (ids[path]) return Promise.resolve(ids[path]);
      var parts = path.split("/"), cur = "root", built = "";
      return parts.reduce(function (p, part) {
        return p.then(function (id) {
          if (id === null) return null;
          built = built ? built + "/" + part : part;
          if (ids[built]) return ids[built];
          return findChild(id, part, FOLDER).then(function (f) {
            if (f) return (ids[built] = f.id);
            return create ? createFolder(id, part).then(function (n) { return (ids[built] = n.id); }) : null;
          });
        });
      }, Promise.resolve(cur));
    }

    function readText(fileId) { return call(API + "/files/" + fileId + "?alt=media").then(function (r) { return r.text(); }); }
    function readBlob(fileId) { return call(API + "/files/" + fileId + "?alt=media").then(function (r) { return r.blob(); }); }

    // create or overwrite a small text file called `name` inside folder `parentId`
    function writeText(parentId, name, text) {
      return findChild(parentId, name).then(function (f) {
        if (f) {
          return json(UPLOAD + "/files/" + f.id + "?uploadType=media&fields=id", {
            method: "PATCH", headers: { "Content-Type": "text/plain" }, body: text
          });
        }
        var b = "macwatch" + Math.random().toString(16).slice(2);
        var body = "--" + b + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
          JSON.stringify({ name: name, parents: [parentId] }) +
          "\r\n--" + b + "\r\nContent-Type: text/plain\r\n\r\n" + text + "\r\n--" + b + "--";
        return json(UPLOAD + "/files?uploadType=multipart&fields=id", {
          method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + b }, body: body
        });
      });
    }

    function remove(fileId) { return call(API + "/files/" + fileId, { method: "DELETE" }); }

    function move(fileId, fromParent, toParent) {
      return json(API + "/files/" + fileId + "?addParents=" + encodeURIComponent(toParent) +
        "&removeParents=" + encodeURIComponent(fromParent) + "&fields=id", { method: "PATCH" });
    }

    return {
      list: list, findChild: findChild, createFolder: createFolder, folderId: folderId,
      readText: readText, readBlob: readBlob, writeText: writeText, remove: remove, move: move,
      forget: function () { ids = {}; }
    };
  }
  return { createDrive: createDrive, FOLDER: FOLDER };
});
