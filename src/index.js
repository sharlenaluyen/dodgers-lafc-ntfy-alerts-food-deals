// src/index.js
// Cloudflare Worker entry point. Two Cron Triggers call this on a schedule
// (see wrangler.toml): a frequent check during the part of the day games
// are realistically being played, and a once-daily morning recap. Every
// integration in src/integrations.js shares this same schedule — kickoff
// times fall inside the existing window, so no extra Cron Triggers were
// needed. There's also a manual /test-notify route for verifying the ntfy
// path works without waiting for a real game.

import { publish, dodgersTopics } from "./ntfy.js";
import { checkAndNotify, sendMorningRecap } from "./jobs.js";
import { INTEGRATIONS } from "./integrations.js";

const deps = { publish };

// Must match the once-daily recap trigger in wrangler.toml exactly, so we
// know which of the (several) cron schedules just fired.
const MORNING_CRON = "0 15 * * *";

export default {
  async scheduled(event, env, ctx) {
    const run = event.cron === MORNING_CRON ? sendMorningRecap : checkAndNotify;
    const jobs = INTEGRATIONS.map((integration) => run(env, deps, integration));

    // allSettled, not all — a broken integration (e.g. LAFC/ESPN) shouldn't
    // take down the others.
    ctx.waitUntil(
      Promise.allSettled(jobs).then((results) => {
        for (const r of results) {
          if (r.status === "rejected") console.error(`[scheduled ${event.cron}] error:`, r.reason);
        }
      })
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/test-notify") {
      if (!env.ADMIN_SECRET || url.searchParams.get("secret") !== env.ADMIN_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const target = url.searchParams.get("target"); // an integration id (e.g. "lafc"), "ops", or omitted (default: Dodgers)
      const integration = INTEGRATIONS.find((i) => i.id === target);
      const topics = !target ? dodgersTopics(env) : target === "ops" ? [env.NTFY_OPS_TOPIC] : integration?.topics(env);
      if (target && !(topics && topics[0])) {
        return new Response(`no topic configured for target=${target}`, { status: 400 });
      }
      try {
        await publish(env, `Test notification from Dodgers alerts (target=${target || "dodgers"}).`, {
          title: "Dodgers Alerts Test",
          topics,
        });
        return new Response("ok");
      } catch (err) {
        return new Response(err.message, { status: 500 });
      }
    }

    return new Response("Dodgers win alerts worker is running.");
  },
};
