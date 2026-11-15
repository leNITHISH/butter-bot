// Cloudflare glue for the mac-watch Worker. All logic lives in core.js (tested in node).
import { makeApp } from "./core.js";
import { makeB2 } from "./b2.js";

const app = makeApp({
  b2: (env, { kv, budget, now }) => makeB2(env, { fetchFn: (u, i) => fetch(u, i), kv, now, budget })
});

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (event, env, ctx) => { ctx.waitUntil(app.scheduled(event, env, ctx)); }
};
