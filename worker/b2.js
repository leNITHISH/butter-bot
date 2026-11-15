// Backblaze B2 native API client for the Worker. Only what mac-watch needs.
// Every call goes through `fetchFn` and spends one unit of `budget.left` (the free Workers plan
// allows about 50 outgoing requests per invocation; callers keep a margin).
//
// Transaction classes (free allowance per day, check https://www.backblaze.com/cloud-storage/transaction-pricing):
//   delete_file_version, upload: class A (free, unlimited)
//   download_file_by_name: class B (2,500/day free)
//   authorize_account, list_file_names, copy_file: class C (2,500/day free)
// The authorization is cached in D1 for 23 h so it costs about one class C call per day.

const AUTH_URL = "https://api.backblazeb2.com/b2api/v3/b2_authorize_account";
const AUTH_TTL = 23 * 3600;

export class BudgetError extends Error {}

export function makeB2(env, { fetchFn, kv, now, budget }) {
  let auth = null;

  function spend() {
    if (budget.left <= 0) throw new BudgetError("subrequest budget used up");
    budget.left--;
  }

  async function authorize(force) {
    if (!force && auth && auth.exp > now()) return auth;
    if (!force) {
      const cached = await kv.get("b2_auth");
      if (cached) {
        try {
          const a = JSON.parse(cached);
          if (a.exp > now() && a.keyId === env.B2_KEY_ID) { auth = a; return auth; }
        } catch (e) { /* refetch */ }
      }
    }
    if (!env.B2_KEY_ID || !env.B2_APP_KEY || !env.B2_BUCKET) throw new Error("B2 is not configured");
    spend();
    const res = await fetchFn(AUTH_URL, { headers: { Authorization: "Basic " + btoa(env.B2_KEY_ID + ":" + env.B2_APP_KEY) } });
    if (!res.ok) throw new Error("B2 authorize failed: HTTP " + res.status);
    const j = await res.json();
    const s = (j.apiInfo && j.apiInfo.storageApi) || {};
    const allowed = s.allowed || {};
    let bucketId = null;
    if (Array.isArray(allowed.buckets)) {
      const b = allowed.buckets.find((x) => x && x.name === env.B2_BUCKET);
      if (b) bucketId = b.id;
    } else if (allowed.bucketName === env.B2_BUCKET) {
      bucketId = allowed.bucketId;
    }
    auth = { token: j.authorizationToken, apiUrl: s.apiUrl, downloadUrl: s.downloadUrl, accountId: j.accountId,
             bucketId, keyId: env.B2_KEY_ID, exp: now() + AUTH_TTL };
    if (!auth.bucketId) {
      // key not restricted to one bucket: look the bucket up by name
      const r = await call("b2_list_buckets", { accountId: auth.accountId, bucketName: env.B2_BUCKET }, true);
      const b = (r.buckets || [])[0];
      if (!b) throw new Error("B2 bucket not found or not allowed for this key");
      auth.bucketId = b.bucketId;
    }
    await kv.set("b2_auth", JSON.stringify(auth));
    return auth;
  }

  async function call(op, body, noRetry) {
    const a = auth || await authorize(false);
    spend();
    let res = await fetchFn(a.apiUrl + "/b2api/v3/" + op, {
      method: "POST", headers: { Authorization: a.token, "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    if (res.status === 401 && !noRetry) {
      await authorize(true);
      return call(op, body, true);
    }
    if (!res.ok) {
      let code = "";
      try { code = (await res.json()).code || ""; } catch (e) { /* ignore */ }
      const err = new Error("B2 " + op + " failed: HTTP " + res.status + (code ? " " + code : ""));
      err.status = res.status; err.code = code;
      throw err;
    }
    return res.json();
  }

  function encodeKey(key) { return key.split("/").map(encodeURIComponent).join("/"); }

  return {
    authorize,

    // -> { files: [{ name, id, size, ts }], next }   (only real uploads, not hide markers)
    async list(prefix, startFileName, maxFileCount) {
      const a = auth || await authorize(false);
      const body = { bucketId: a.bucketId, prefix: prefix || "", maxFileCount: maxFileCount || 1000 };
      if (startFileName) body.startFileName = startFileName;
      const r = await call("b2_list_file_names", body);
      return {
        files: (r.files || []).filter((f) => f.action === "upload")
          .map((f) => ({ name: f.fileName, id: f.fileId, size: f.contentLength, ts: f.uploadTimestamp })),
        next: r.nextFileName || null
      };
    },

    async remove(name, id) {
      return call("b2_delete_file_version", { fileName: name, fileId: id });
    },

    async copy(sourceId, newName) {
      const r = await call("b2_copy_file", { sourceFileId: sourceId, fileName: newName, metadataDirective: "COPY" });
      return { name: r.fileName, id: r.fileId, size: r.contentLength };
    },

    // Streams one object. Passes Range through (video seeking). Returns the raw fetch Response.
    async download(key, range) {
      let a = auth || await authorize(false);
      const go = async () => {
        spend();
        const h = { Authorization: a.token };
        if (range) h.Range = range;
        return fetchFn(a.downloadUrl + "/file/" + encodeURIComponent(env.B2_BUCKET) + "/" + encodeKey(key), { headers: h });
      };
      let res = await go();
      if (res.status === 401) { a = await authorize(true); res = await go(); }
      return res;
    }
  };
}
