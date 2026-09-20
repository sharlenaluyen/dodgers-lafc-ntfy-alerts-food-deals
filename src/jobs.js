// src/jobs.js
// The two jobs: notify immediately on a finished home win, and send a
// bundled next-morning recap. No database — just a tiny per-game flag in
// Workers KV so a game already published isn't published again. Flags
// expire on their own after a couple of days, so nothing is kept around.

const FLAG_TTL_SECONDS = 60 * 60 * 24 * 2; // 2 days — comfortably longer than the 24h lookback

async function alreadyFlagged(env, key) {
  return (await env.DODGERS_KV.get(key)) !== null;
}

async function setFlag(env, key) {
  await env.DODGERS_KV.put(key, "1", { expirationTtl: FLAG_TTL_SECONDS });
}

// ---------------------------------------------------------------------------
// LAFC/Ono Hawaiian BBQ integration relies on an undocumented ESPN API (see
// src/mls.js) that could change shape or start rejecting requests without
// notice. Rather than fail silently, a broken run raises a one-time ops
// alert to NTFY_OPS_TOPIC so it gets noticed and fixed. Deduped via a KV
// flag with a shorter TTL than the win-flags above, so a persistent outage
// pages once and then stays quiet instead of alerting on every cron tick.
// ---------------------------------------------------------------------------
const OPS_ALERT_TTL_SECONDS = 60 * 60 * 6; // 6h

async function alertOps(env, deps, kind, message) {
  console.error(`[ops alert:${kind}]`, message);

  const flagKey = `ops-alerted:${kind}`;
  if (await alreadyFlagged(env, flagKey)) return; // already paged for this within the last 6h

  if (!env.NTFY_OPS_TOPIC) return; // no ops topic configured — logged above, nothing more to do

  await deps.publish(env, message, { title: "⚠️ LAFC/Ono integration error", topics: [env.NTFY_OPS_TOPIC] });
  await env.DODGERS_KV.put(flagKey, "1", { expirationTtl: OPS_ALERT_TTL_SECONDS });
}

// ---------------------------------------------------------------------------
// Check for a finished Dodgers home win and publish immediately. Away wins
// and any loss are simply skipped — nothing is published for them, and
// nothing needs to be recorded either, since we only ever ask "did the
// Dodgers just win at home" fresh each run.
// ---------------------------------------------------------------------------
export async function checkAndNotify(env, deps) {
  const { getRecentFinishedGames } = deps;
  const { publish } = deps;

  const games = await getRecentFinishedGames(env);
  const wins = games.filter((g) => g.isHomeGame && g.dodgersWon);

  for (const win of wins) {
    const key = `notified:${win.gamePk}`;
    if (await alreadyFlagged(env, key)) continue; // already published this one

    await publish(env, `The Dodgers WIN at home! Final: ${win.summary}. Go Blue! Use code "DODGERSWIN" on the app for $7 Panda Plate.`, {
      title: "⚾ Dodgers Win!",
    });
    await setFlag(env, key);
  }
}

// ---------------------------------------------------------------------------
// Once-daily morning recap: bundles every home win in the lookback window
// that hasn't had its recap sent yet into one message (so a doubleheader
// sweep is one text, not two).
// ---------------------------------------------------------------------------
export async function sendMorningRecap(env, deps) {
  const { getRecentFinishedGames } = deps;
  const { publish } = deps;

  const games = await getRecentFinishedGames(env);
  const wins = games.filter((g) => g.isHomeGame && g.dodgersWon);

  const pending = [];
  for (const win of wins) {
    if (!(await alreadyFlagged(env, `recap:${win.gamePk}`))) pending.push(win);
  }
  if (pending.length === 0) return;

  const summaries = pending.map((g) => `beat the ${g.opponent} ${g.dodgersScore}-${g.opponentScore}`);
  const text =
    summaries.length === 1
      ? `Morning reminder: the Dodgers ${summaries[0]} at home last night! Go Blue! Use code "DODGERSWIN" on the app for $7 Panda Plate.`
      : `Morning recap: the Dodgers ${summaries.join(", and ")} at home! Go Blue! Use code "DODGERSWIN" on the app for $7 Panda Plate.`;

  await publish(env, text, { title: "☀️ Dodgers Morning Recap" });

  for (const win of pending) {
    await setFlag(env, `recap:${win.gamePk}`);
  }
}

// ---------------------------------------------------------------------------
// Same shape as checkAndNotify()/sendMorningRecap() above, but for the Ono
// Hawaiian BBQ "LAFCSCORES" promo: triggers when LAFC scores the match's
// first goal in the first half of a home game (win/loss/draw don't matter).
// Publishes to its own topic (NTFY_TOPIC_LAFC) so Dodgers/Panda subscribers
// don't get LAFC alerts and vice versa.
// ---------------------------------------------------------------------------
export async function checkAndNotifyLAFC(env, deps) {
  const { getRecentFinishedHomeGames, publish } = deps;

  let games;
  try {
    games = await getRecentFinishedHomeGames(env);
  } catch (err) {
    await alertOps(env, deps, `lafc-${err.kind || "unknown"}`, `LAFC check failed (${err.kind || "unknown"}): ${err.message}`);
    return;
  }

  const hits = games.filter((g) => g.scoredFirstInFirstHalf);

  for (const hit of hits) {
    const key = `lafc-notified:${hit.eventId}`;
    if (await alreadyFlagged(env, key)) continue; // already published this one

    await publish(
      env,
      `LAFC scored first in the first half! Final: ${hit.summary}. Use code "LAFCSCORES" at Ono Hawaiian BBQ tomorrow for a $5.99 chicken plate.`,
      { title: "⚽ LAFC Scores First!", topics: [env.NTFY_TOPIC_LAFC] }
    );
    await setFlag(env, key);
  }
}

export async function sendMorningRecapLAFC(env, deps) {
  const { getRecentFinishedHomeGames, publish } = deps;

  let games;
  try {
    games = await getRecentFinishedHomeGames(env);
  } catch (err) {
    await alertOps(env, deps, `lafc-${err.kind || "unknown"}`, `LAFC recap failed (${err.kind || "unknown"}): ${err.message}`);
    return;
  }

  const hits = games.filter((g) => g.scoredFirstInFirstHalf);

  const pending = [];
  for (const hit of hits) {
    if (!(await alreadyFlagged(env, `lafc-recap:${hit.eventId}`))) pending.push(hit);
  }
  if (pending.length === 0) return;

  const summaries = pending.map((g) => `scored first against the ${g.opponent} (final: ${g.summary})`);
  const text =
    summaries.length === 1
      ? `Morning reminder: LAFC ${summaries[0]} last night! Use code "LAFCSCORES" at Ono Hawaiian BBQ today for a $5.99 chicken plate.`
      : `Morning recap: LAFC ${summaries.join(", and ")}! Use code "LAFCSCORES" at Ono Hawaiian BBQ today for a $5.99 chicken plate.`;

  await publish(env, text, { title: "☀️ LAFC Morning Recap", topics: [env.NTFY_TOPIC_LAFC] });

  for (const hit of pending) {
    await setFlag(env, `lafc-recap:${hit.eventId}`);
  }
}
