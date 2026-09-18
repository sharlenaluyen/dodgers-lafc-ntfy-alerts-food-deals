// src/index.js
// Cloudflare Worker entry point. Two Cron Triggers call this on a schedule
// (see wrangler.toml): a frequent check during the part of the day Dodgers
// games are realistically being played, and a once-daily morning recap.
// There's also a manual /test-notify route for verifying the ntfy path
// works without waiting for a real game.

import { getRecentFinishedGames } from "./mlb.js";
import { publish } from "./ntfy.js";
import { checkAndNotify, sendMorningRecap } from "./jobs.js";

const deps = { getRecentFinishedGames, publish };

// Must match the once-daily recap trigger in wrangler.toml exactly, so we
// know which of the (several) cron schedules just fired.
const MORNING_CRON = "0 15 * * *";

export default {
  async scheduled(event, env, ctx) {
    const job =
      event.cron === MORNING_CRON
        ? sendMorningRecap(env, deps)
        : checkAndNotify(env, deps);

    ctx.waitUntil(job.catch((err) => console.error(`[scheduled ${event.cron}] error:`, err)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/test-notify") {
      if (!env.ADMIN_SECRET || url.searchParams.get("secret") !== env.ADMIN_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        await publish(env, "Test notification from Dodgers alerts.", { title: "Dodgers Alerts Test" });
        return new Response("ok");
      } catch (err) {
        return new Response(err.message, { status: 500 });
      }
    }

    return new Response("Dodgers win alerts worker is running.");
  },
};
