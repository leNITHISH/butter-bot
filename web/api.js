/* mac-watch: the page's client for the Worker API (same origin, session cookie).
   No secrets here: the browser only ever holds an HttpOnly cookie it cannot read. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MacWatchApi = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function ApiError(message, status, details) {
    var e = new Error(message);
    e.status = status; e.details = details || [];
    return e;
  }

  function encodeKey(key) {
    return String(key).split("/").map(encodeURIComponent).join("/");
  }

  function makeApi(fetchFn) {
    function req(method, path, body) {
      var opts = { method: method, credentials: "same-origin", headers: {} };
      if (method !== "GET") {
        opts.headers["X-MW"] = "1";                 // our CSRF guard (a form post cannot set it)
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body === undefined ? {} : body);
      }
      return fetchFn(path, opts).then(function (r) {
        return r.text().then(function (t) {
          var data = null;
          try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
          if (r.status === 401) throw ApiError("signin", 401);
          if (!r.ok) throw ApiError((data && data.error) || ("HTTP " + r.status), r.status, data && data.errors);
          return data;
        });
      });
    }
    function q(params) {
      var parts = [];
      Object.keys(params).forEach(function (k) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== "") parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
      });
      return parts.length ? "?" + parts.join("&") : "";
    }
    return {
      config: function () { return req("GET", "/auth/config"); },
      signIn: function (credential) { return req("POST", "/auth/google", { credential: credential }); },
      signOut: function () { return req("POST", "/auth/logout", {}); },
      status: function () { return req("GET", "/api/status"); },
      storage: function () { return req("GET", "/api/storage"); },
      days: function (kind) { return req("GET", "/api/days" + q({ kind: kind })); },
      files: function (kind, day, after, limit) { return req("GET", "/api/files" + q({ kind: kind, day: day, after: after, limit: limit })); },
      live: function () { return req("GET", "/api/live"); },
      command: function (name) { return req("POST", "/api/command", { name: name }); },
      watching: function () { return req("POST", "/api/watching", {}); },
      settings: function () { return req("GET", "/api/settings"); },
      saveSettings: function (values) { return req("PUT", "/api/settings", { values: values }); },
      keep: function (keys) { return req("POST", "/api/keep", { keys: keys }); },
      purge: function (body) { return req("POST", "/api/purge", body); },
      imgUrl: function (key) { return "/img/" + encodeKey(key); },
      dlUrl: function (key) { return "/dl/" + encodeKey(key); }
    };
  }

  return { makeApi: makeApi, encodeKey: encodeKey };
});
