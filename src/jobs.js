// src/jobs.js
// Generic check/recap job runners shared by every integration in
// src/integrations.js. No database — just a tiny per-game flag in Workers
// KV so a game already published isn't published again. Flags expire on
// their own after a couple of days, so nothing is kept around.

const FLAG_TTL_SECONDS = 60 * 60 * 24 * 2; // 2 days — comfortably longer than the 24h lookback

async function alreadyFlagged(env, key) {
  return (await env.DODGERS_KV.get(key)) !== null;
}

async function setFlag(env, key) {
  await env.DODGERS_KV.put(key, "1", { expirationTtl: FLAG_TTL_SECONDS });
}

function keyFor(prefix, id) {
  return `${prefix}:${id}`;
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
// Fetch an integration's games, filtered down to hits. `keyPrefix` is which
// KV namespace ("already handled") applies to this call — passed through as
// a `skip(id)` check the fetcher can use to avoid extra per-game fetches for
// games it doesn't need to re-fetch (e.g. mls.js's per-event summary call).
// It's purely an optimization: fetchers that ignore it just return everything,
// and the alreadyFlagged() checks below still guarantee no double-publish.
// Returns null if the fetch failed and was already routed to an ops alert.
// ---------------------------------------------------------------------------
async function fetchHits(env, deps, integration, keyPrefix) {
  try {
    const games = await integration.getGames(env, { skip: (id) => alreadyFlagged(env, keyFor(keyPrefix, id)) });
    return games.filter(integration.filterHits);
  } catch (err) {
    if (!integration.opsLabel) throw err;
    const kind = err.kind || "unknown";
    await alertOps(env, deps, `${integration.opsLabel}-${kind}`, `${integration.id} check failed (${kind}): ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Check for a finished, qualifying game and publish immediately. Games that
// don't qualify are simply skipped — nothing is published for them, and
// nothing needs to be recorded either, since we ask "does this qualify"
// fresh each run.
// ---------------------------------------------------------------------------
export async function checkAndNotify(env, deps, integration) {
  const hits = await fetchHits(env, deps, integration, integration.checkKeyPrefix);
  if (hits === null) return; // fetch failed; already routed to an ops alert

  for (const hit of hits) {
    const key = keyFor(integration.checkKeyPrefix, integration.idOf(hit));
    if (await alreadyFlagged(env, key)) continue; // already published this one

    await deps.publish(env, integration.buildMessage(hit), { title: integration.checkTitle, topics: integration.topics(env) });
    await setFlag(env, key);
  }
}

// ---------------------------------------------------------------------------
// Once-daily morning recap: bundles every qualifying game in the lookback
// window that hasn't had its recap sent yet into one message (so a
// doubleheader sweep is one text, not two).
// ---------------------------------------------------------------------------
export async function sendMorningRecap(env, deps, integration) {
  const hits = await fetchHits(env, deps, integration, integration.recapKeyPrefix);
  if (hits === null) return; // fetch failed; already routed to an ops alert

  const pending = [];
  for (const hit of hits) {
    const key = keyFor(integration.recapKeyPrefix, integration.idOf(hit));
    if (!(await alreadyFlagged(env, key))) pending.push(hit);
  }
  if (pending.length === 0) return;

  const summaries = pending.map(integration.buildSummary);
  await deps.publish(env, integration.buildRecapText(summaries), { title: integration.recapTitle, topics: integration.topics(env) });

  for (const hit of pending) {
    await setFlag(env, keyFor(integration.recapKeyPrefix, integration.idOf(hit)));
  }
}
