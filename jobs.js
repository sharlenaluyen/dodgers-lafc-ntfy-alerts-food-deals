// jobs.js
// The two background jobs: checking for a finished home win (published
// immediately) and sending the next-morning recap. Kept separate from
// server.js so they're easy to unit-test without booting the HTTP server.

const db = require("./db");
const { getRecentFinishedGames } = require("./mlb");
const { publish } = require("./ntfy");

// ---------------------------------------------------------------------------
// Job #1: check for a newly-finished Dodgers game. Only a HOME win (at
// Dodger Stadium) gets an immediate notification; away wins and any loss are
// just recorded so we don't re-check them, but nothing is published for them.
// Idempotent via the notified_games table, so it's safe to run on a tight
// schedule.
// ---------------------------------------------------------------------------
async function checkAndNotify() {
  let games;
  try {
    games = await getRecentFinishedGames();
  } catch (err) {
    console.error("[checkAndNotify] failed to fetch MLB scores:", err.message);
    return;
  }

  for (const game of games) {
    if (db.hasNotifiedGame(game.gamePk)) continue; // already evaluated this game

    const shouldNotify = game.isHomeGame && game.dodgersWon;

    if (!shouldNotify) {
      db.recordProcessedGame({
        gamePk: game.gamePk,
        gameDate: game.gameDate,
        isHome: game.isHomeGame,
        isWin: false,
        opponent: game.opponent,
        dodgersScore: game.dodgersScore,
        opponentScore: game.opponentScore,
        result: `${game.summary}${game.isHomeGame ? "" : ` (away, at ${game.venueName})`}`,
      });
      continue;
    }

    const text = `The Dodgers WIN at home! Final: ${game.summary}. Go Blue!`;
    console.log(`[checkAndNotify] Dodgers won at home (gamePk ${game.gamePk}): ${game.summary}. Publishing.`);

    try {
      await publish(text, { title: "⚾ Dodgers Win!" });
      console.log("[checkAndNotify] published.");
    } catch (err) {
      console.error("[checkAndNotify] publish failed:", err.message);
    }

    db.recordProcessedGame({
      gamePk: game.gamePk,
      gameDate: game.gameDate,
      isHome: true,
      isWin: true,
      opponent: game.opponent,
      dodgersScore: game.dodgersScore,
      opponentScore: game.opponentScore,
      result: game.summary,
    });
  }
}

// ---------------------------------------------------------------------------
// Job #2: the next-morning recap. Any home win that already got its
// immediate notification but hasn't had a morning follow-up gets one bundled
// message (handles doubleheaders as a single notification instead of two).
// ---------------------------------------------------------------------------
async function sendMorningRecap() {
  const pending = db.getPendingMorningWins();
  if (pending.length === 0) return;

  const wins = pending.map((g) => `beat the ${g.opponent} ${g.dodgers_score}-${g.opponent_score}`);
  const text =
    wins.length === 1
      ? `Morning reminder: the Dodgers ${wins[0]} at home last night! Go Blue!`
      : `Morning recap: the Dodgers ${wins.join(", and ")} at home! Go Blue!`;

  console.log(`[sendMorningRecap] ${pending.length} pending win(s). Publishing.`);

  try {
    await publish(text, { title: "☀️ Dodgers Morning Recap" });
    console.log("[sendMorningRecap] published.");
  } catch (err) {
    console.error("[sendMorningRecap] publish failed:", err.message);
  }

  db.markMorningSent(pending.map((g) => g.game_pk));
}

function getLocalHour(tz) {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date())
  );
}

module.exports = { checkAndNotify, sendMorningRecap, getLocalHour };
