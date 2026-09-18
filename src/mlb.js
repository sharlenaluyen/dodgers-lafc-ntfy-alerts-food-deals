// src/mlb.js
// Polls the free, keyless MLB Stats API for the Dodgers' games and reports
// back any finished games in roughly the last 24h.

export async function getRecentFinishedGames(env) {
  const teamId = Number(env.MLB_TEAM_ID || 119); // 119 = LA Dodgers
  const homeVenueMatch = (env.HOME_VENUE_MATCH || "dodger stadium").toLowerCase();

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const url =
    `https://statsapi.mlb.com/api/v1/schedule` +
    `?sportId=1&teamId=${teamId}&startDate=${fmt(yesterday)}&endDate=${fmt(now)}` +
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

      const dodgersIsHomeTeam = home.team?.id === teamId;
      const dodgers = dodgersIsHomeTeam ? home : away;
      const opponent = dodgersIsHomeTeam ? away : home;
      const dodgersWon = dodgers.isWinner === true;

      const venueName = game.venue?.name || "";
      // Require the game was actually played at Dodger Stadium, not just that
      // MLB's schedule lists the Dodgers as the "home" team (covers the rare
      // neutral-site "home" game, e.g. an international series).
      const isHomeGame = dodgersIsHomeTeam && venueName.toLowerCase().includes(homeVenueMatch);

      const oppName = opponent.team?.name || "their opponent";
      const dScore = dodgers.score;
      const oScore = opponent.score;

      results.push({
        gamePk: game.gamePk,
        gameDate: game.gameDate,
        dodgersWon,
        isHomeGame,
        venueName,
        opponent: oppName,
        dodgersScore: dScore,
        opponentScore: oScore,
        summary: `Dodgers ${dScore}, ${oppName} ${oScore}`,
      });
    }
  }
  return results;
}
