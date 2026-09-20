// src/jobs.js
// The check/recap job pairs for each integration (Dodgers/Panda, LAFC/Ono).
// No database — just a tiny per-game flag in Workers KV so a game already
// published isn't published again. Flags expire on their own after a
// couple of days, so nothing is kept around.

import { dodgersTopics, lafcTopics } from "./ntfy.js";

const FLAG_TTL_SECONDS = 60 * 60 * 24 * 2; // 2 days — comfortably longer than the 24h lookback

async function alreadyFlagged(env, key) {
  return (await env.DODGERS_KV.get(key)) !== null;
}

async function setFlag(env, key) {
  await env.DODGERS_KV.put(key, "1", { expirationTtl: FLAG_TTL_SECONDS });
}

// ---------------------------------------------------------------------------
// Some integrations (currently just LAFC/ESPN) rely on an undocumented API
// that could change shape or start rejecting requests without notice.
// Rather than fail silently, a broken run raises a one-time ops alert to
// NTFY_OPS_TOPIC so it gets noticed and fixed. Deduped via a KV flag with a
// shorter TTL than the win-flags above, so a persistent outage pages once
// and then stays quiet instead of alerting on every cron tick.
// ---------------------------------------------------------------------------
const OPS_ALERT_TTL_SECONDS = 60 * 60 * 6; // 6h

async function alertOps(env, deps, kind, message) {
  console.error(`[ops alert:${kind}]`, message);

  const flagKey = `ops-alerted:${kind}`;
  if (await alreadyFlagged(env, flagKey)) return; // already paged for this within the last 6h

  if (!env.NTFY_OPS_TOPIC) return; // no ops topic configured — logged above, nothing more to do

  await deps.publish(env, message, { title: `⚠️ Integration error (${kind})`, topics: [env.NTFY_OPS_TOPIC] });
  await env.DODGERS_KV.put(flagKey, "1", { expirationTtl: OPS_ALERT_TTL_SECONDS });
}

// ---------------------------------------------------------------------------
// Shared shape behind every check/recap pair below: fetch games from the
// source, optionally routing a fetch failure to an ops alert (`opsLabel`)
// instead of letting it propagate, then filter down to the ones that matter.
// Returns null if the fetch failed and was already routed to an ops alert.
// ---------------------------------------------------------------------------
async function fetchHits(env, deps, { getGames, filterHits, opsLabel, actionLabel }) {
  let games;
  if (!opsLabel) {
    games = await getGames(env);
  } else {
    try {
      games = await getGames(env);
    } catch (err) {
      const kind = err.kind || "unknown";
      await alertOps(env, deps, `${opsLabel}-${kind}`, `${actionLabel} failed (${kind}): ${err.message}`);
      return null;
    }
  }
  return games.filter(filterHits);
}

// Publish immediately for every unflagged hit, then flag it.
async function notifyOnce(env, deps, hits, { keyOf, buildMessage, publishOpts }) {
  for (const hit of hits) {
    const key = keyOf(hit);
    if (await alreadyFlagged(env, key)) continue; // already published this one

    await deps.publish(env, buildMessage(hit), publishOpts);
    await setFlag(env, key);
  }
}

// Bundle every unflagged hit into one recap message, then flag them all.
async function sendRecap(env, deps, hits, { keyOf, buildSummary, buildText, publishOpts }) {
  const pending = [];
  for (const hit of hits) {
    if (!(await alreadyFlagged(env, keyOf(hit)))) pending.push(hit);
  }
  if (pending.length === 0) return;

  await deps.publish(env, buildText(pending.map(buildSummary)), publishOpts);

  for (const hit of pending) {
    await setFlag(env, keyOf(hit));
  }
}

// ---------------------------------------------------------------------------
// Check for a finished Dodgers home win and publish immediately. Away wins
// and any loss are simply skipped — nothing is published for them, and
// nothing needs to be recorded either, since we only ever ask "did the
// Dodgers just win at home" fresh each run.
// ---------------------------------------------------------------------------
export async function checkAndNotify(env, deps) {
  const hits = await fetchHits(env, deps, {
    getGames: deps.getRecentFinishedGames,
    filterHits: (g) => g.isHomeGame && g.dodgersWon,
  });

  await notifyOnce(env, deps, hits, {
    keyOf: (win) => `notified:${win.gamePk}`,
    buildMessage: (win) =>
      `The Dodgers WIN at home! Final: ${win.summary}. Go Blue! Use code "DODGERSWIN" on the app for $7 Panda Plate.`,
    publishOpts: { title: "⚾ Dodgers Win!", topics: dodgersTopics(env) },
  });
}

// ---------------------------------------------------------------------------
// Once-daily morning recap: bundles every home win in the lookback window
// that hasn't had its recap sent yet into one message (so a doubleheader
// sweep is one text, not two).
// ---------------------------------------------------------------------------
export async function sendMorningRecap(env, deps) {
  const hits = await fetchHits(env, deps, {
    getGames: deps.getRecentFinishedGames,
    filterHits: (g) => g.isHomeGame && g.dodgersWon,
  });

  await sendRecap(env, deps, hits, {
    keyOf: (win) => `recap:${win.gamePk}`,
    buildSummary: (g) => `beat the ${g.opponent} ${g.dodgersScore}-${g.opponentScore}`,
    buildText: (summaries) =>
      summaries.length === 1
        ? `Morning reminder: the Dodgers ${summaries[0]} at home last night! Go Blue! Use code "DODGERSWIN" on the app for $7 Panda Plate.`
        : `Morning recap: the Dodgers ${summaries.join(", and ")} at home! Go Blue! Use code "DODGERSWIN" on the app for $7 Panda Plate.`,
    publishOpts: { title: "☀️ Dodgers Morning Recap", topics: dodgersTopics(env) },
  });
}

// ---------------------------------------------------------------------------
// Same shape as checkAndNotify()/sendMorningRecap() above, but for the Ono
// Hawaiian BBQ "LAFCSCORES" promo: triggers when LAFC scores the match's
// first goal in the first half of a home game (win/loss/draw don't matter).
// Publishes to its own topic (NTFY_TOPIC_LAFC) so Dodgers/Panda subscribers
// don't get LAFC alerts and vice versa.
// ---------------------------------------------------------------------------
export async function checkAndNotifyLAFC(env, deps) {
  const hits = await fetchHits(env, deps, {
    getGames: deps.getRecentFinishedHomeGames,
    filterHits: (g) => g.scoredFirstInFirstHalf,
    opsLabel: "lafc",
    actionLabel: "LAFC check",
  });
  if (hits === null) return; // fetch failed; already routed to an ops alert

  await notifyOnce(env, deps, hits, {
    keyOf: (hit) => `lafc-notified:${hit.eventId}`,
    buildMessage: (hit) =>
      `LAFC scored first in the first half! Final: ${hit.summary}. Use code "LAFCSCORES" at Ono Hawaiian BBQ tomorrow for a $5.99 chicken plate.`,
    publishOpts: { title: "⚽ LAFC Scores First!", topics: lafcTopics(env) },
  });
}

export async function sendMorningRecapLAFC(env, deps) {
  const hits = await fetchHits(env, deps, {
    getGames: deps.getRecentFinishedHomeGames,
    filterHits: (g) => g.scoredFirstInFirstHalf,
    opsLabel: "lafc",
    actionLabel: "LAFC recap",
  });
  if (hits === null) return; // fetch failed; already routed to an ops alert

  await sendRecap(env, deps, hits, {
    keyOf: (hit) => `lafc-recap:${hit.eventId}`,
    buildSummary: (g) => `scored first against the ${g.opponent} (final: ${g.summary})`,
    buildText: (summaries) =>
      summaries.length === 1
        ? `Morning reminder: LAFC ${summaries[0]} last night! Use code "LAFCSCORES" at Ono Hawaiian BBQ today for a $5.99 chicken plate.`
        : `Morning recap: LAFC ${summaries.join(", and ")}! Use code "LAFCSCORES" at Ono Hawaiian BBQ today for a $5.99 chicken plate.`,
    publishOpts: { title: "☀️ LAFC Morning Recap", topics: lafcTopics(env) },
  });
}
