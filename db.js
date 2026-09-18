// db.js
// Tiny SQLite wrapper: just which games we've already evaluated/notified
// about. There's no subscriber list to store — ntfy's topic subscriptions
// live on ntfy's side, not ours.

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "data.sqlite");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

// One row per game we've evaluated (home or away, win or loss), so the
// poller never reconsiders the same gamePk twice. is_home + is_win gate
// whether it was published immediately; morning_sent gates the next-day recap.
db.exec(`
  CREATE TABLE IF NOT EXISTS notified_games (
    game_pk INTEGER PRIMARY KEY,
    game_date TEXT NOT NULL,
    is_home INTEGER NOT NULL DEFAULT 0,
    is_win INTEGER NOT NULL DEFAULT 0,
    opponent TEXT,
    dodgers_score INTEGER,
    opponent_score INTEGER,
    result TEXT NOT NULL,        -- short human summary, e.g. "Dodgers 5, Giants 2"
    notified_at TEXT NOT NULL DEFAULT (datetime('now')),
    morning_sent INTEGER NOT NULL DEFAULT 0,
    morning_sent_at TEXT
  );
`);

function hasNotifiedGame(gamePk) {
  return !!db.prepare("SELECT 1 FROM notified_games WHERE game_pk = ?").get(gamePk);
}

/**
 * Records that we've evaluated a game, so the poller never reconsiders it.
 * `isWin` should only be true for a Dodgers win at Dodger Stadium (the only
 * case that should ever get published) — everything else (away games, home
 * losses) still gets recorded here, just with isWin: false, purely to skip
 * re-checking it on future polls.
 */
function recordProcessedGame({
  gamePk,
  gameDate,
  isHome,
  isWin,
  opponent,
  dodgersScore,
  opponentScore,
  result,
}) {
  db.prepare(
    `INSERT OR IGNORE INTO notified_games
       (game_pk, game_date, is_home, is_win, opponent, dodgers_score, opponent_score, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    gamePk,
    gameDate,
    isHome ? 1 : 0,
    isWin ? 1 : 0,
    opponent || null,
    dodgersScore ?? null,
    opponentScore ?? null,
    result
  );
}

/** Home wins that got their immediate notification but haven't had the morning recap yet. */
function getPendingMorningWins() {
  return db
    .prepare(
      `SELECT * FROM notified_games
       WHERE is_win = 1 AND is_home = 1 AND morning_sent = 0
       ORDER BY notified_at ASC`
    )
    .all();
}

function markMorningSent(gamePks) {
  if (!gamePks.length) return;
  const stmt = db.prepare(
    `UPDATE notified_games SET morning_sent = 1, morning_sent_at = datetime('now') WHERE game_pk = ?`
  );
  const tx = db.transaction((pks) => {
    for (const pk of pks) stmt.run(pk);
  });
  tx(gamePks);
}

module.exports = {
  hasNotifiedGame,
  recordProcessedGame,
  getPendingMorningWins,
  markMorningSent,
};
