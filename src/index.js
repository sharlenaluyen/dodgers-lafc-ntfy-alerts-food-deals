// src/index.js
// Cloudflare Worker entry point. Two Cron Triggers call this on a schedule
// (see wrangler.toml): a frequent check during the part of the day Dodgers
// (and, as it turns out, LAFC) games are realistically being played, and a
// once-daily morning recap. Both the Dodgers/Panda and LAFC/Ono jobs share
// this same schedule — MLS kickoff times fall inside the existing window,
// so no extra Cron Triggers were needed. There's also a manual /test-notify
// route for verifying the ntfy path works without waiting for a real game.

import { getRecentFinishedGames } from "./mlb.js";
import { getRecentFinishedHomeGames } from "./mls.js";
import { publish } from "./ntfy.js";
import { checkAndNotify, sendMorningRecap, checkAndNotifyLAFC, sendMorningRecapLAFC } from "./jobs.js";

const deps = { getRecentFinishedGames, getRecentFinishedHomeGames, publish };

// Must match the once-daily recap trigger in wrangler.toml exactly, so we
// know which of the (several) cron schedules just fired.
const MORNING_CRON = "0 15 * * *";

export default {
  async scheduled(event, env, ctx) {
    const jobs =
      event.cron === MORNING_CRON
        ? [sendMorningRecap(env, deps), sendMorningRecapLAFC(env, deps)]
        : [checkAndNotify(env, deps), checkAndNotifyLAFC(env, deps)];

    // allSettled, not all — a broken LAFC/ESPN integration shouldn't take
    // down the Dodgers/Panda alerts, or vice versa.
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
      const target = url.searchParams.get("target"); // "lafc" | "ops" | omitted (default: Dodgers)
      const topics =
        target === "lafc" ? [env.NTFY_TOPIC_LAFC] : target === "ops" ? [env.NTFY_OPS_TOPIC] : undefined;
      if (target && !topics[0]) {
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
