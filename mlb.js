// mlb.js
// Polls the free, keyless MLB Stats API for the Dodgers' games and reports
// back any newly-finished game, with the final score and whether they won.

const TEAM_ID = Number(process.env.MLB_TEAM_ID || 119); // 119 = LA Dodgers

// Matched as a case-insensitive substring so a naming-rights change (the venue
// is currently "UNIQLO Field at Dodger Stadium" per its sponsorship deal, not
// just "Dodger Stadium") doesn't silently break home-game detection. If the
// stadium is ever renamed to drop "Dodger Stadium" entirely, update this.
const HOME_VENUE_MATCH = (process.env.HOME_VENUE_MATCH || "dodger stadium").toLowerCase();

function todayAndYesterday() {
  // A game that starts at night can finish after midnight UTC weirdness is avoided
  // by just checking "today" and "yesterday" in the server's local date sense.
  const fmt = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return [fmt(yesterday), fmt(now)];
}

/**
 * Returns an array of finished-game summaries for the Dodgers found in the
 * lookback window, each shaped:
 *   { gamePk, gameDate, dodgersWon, isHomeGame, venueName, opponent, dodgersScore, opponentScore, summary }
 */
async function getRecentFinishedGames() {
  const [startDate, endDate] = todayAndYesterday();
  const url =
    `https://statsapi.mlb.com/api/v1/schedule` +
    `?sportId=1&teamId=${TEAM_ID}&startDate=${startDate}&endDate=${endDate}` +
    `&hydrate=team,linescore,venue`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`MLB Stats API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  const results = [];
  for (const day of data.dates || []) {
    for (const game of day.games || []) {
      const state = game.status?.abstractGameState; // 'Preview' | 'Live' | 'Final'
      if (state !== "Final") continue;

      const away = game.teams?.away;
      const home = game.teams?.home;
      if (!away || !home) continue;

      const dodgersIsHomeTeam = home.team?.id === TEAM_ID;
      const dodgers = dodgersIsHomeTeam ? home : away;
      const opponent = dodgersIsHomeTeam ? away : home;
      const dodgersWon = dodgers.isWinner === true;

      const venueName = game.venue?.name || "";
      // Require the game was actually played at Dodger Stadium, not just that
      // MLB's schedule lists the Dodgers as the "home" team (covers the rare
      // neutral-site "home" game, e.g. an international series).
      const isHomeGame = dodgersIsHomeTeam && venueName.toLowerCase().includes(HOME_VENUE_MATCH);

      const oppName = opponent.team?.name || "their opponent";
      const dScore = dodgers.score;
      const oScore = opponent.score;
      const summary = `Dodgers ${dScore}, ${oppName} ${oScore}`;

      results.push({
        gamePk: game.gamePk,
        gameDate: game.gameDate,
        dodgersWon,
        isHomeGame,
        venueName,
        opponent: oppName,
        dodgersScore: dScore,
        opponentScore: oScore,
        summary,
      });
    }
  }
  return results;
}

module.exports = { getRecentFinishedGames, TEAM_ID };
