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
