// src/integrations.js
// Registry of sport/promo integrations. src/jobs.js and src/index.js are
// integration-agnostic — they just run whatever's listed here. To add a new
// one (a third sport, a different promo), you only need:
//   1. A fetcher module (see src/mlb.js or src/mls.js for the shape:
//      `getGames(env, { skip })` returning finished games in the lookback
//      window; `skip(id)` is an optional caller-supplied check the fetcher
//      may use to avoid extra per-game fetches for games already handled).
//   2. A `topics(env)` function in src/ntfy.js (see dodgersTopics/lafcTopics).
//   3. One entry below.
//   4. Its vars (topic names, any API config) in wrangler.toml.

import { getRecentFinishedGames } from "./mlb.js";
import { getRecentFinishedHomeGames } from "./mls.js";
import { dodgersTopics, lafcTopics } from "./ntfy.js";

export const INTEGRATIONS = [
  {
    id: "dodgers",
    getGames: getRecentFinishedGames,
    filterHits: (g) => g.isHomeGame && g.dodgersWon,
    idOf: (win) => win.gamePk,
    checkKeyPrefix: "notified",
    recapKeyPrefix: "recap",
    topics: dodgersTopics,
    checkTitle: "⚾ Dodgers Win!",
    recapTitle: "☀️ Dodgers Morning Recap",
    buildMessage: (win) =>
      `The Dodgers WIN at home! Final: ${win.summary}. Go Blue! Use code "DODGERSWIN" on the app for $7 Panda Plate.`,
    buildSummary: (g) => `beat the ${g.opponent} ${g.dodgersScore}-${g.opponentScore}`,
    buildRecapText: (summaries) =>
      summaries.length === 1
        ? `Morning reminder: the Dodgers ${summaries[0]} at home last night! Go Blue! Use code "DODGERSWIN" on the app for $7 Panda Plate.`
        : `Morning recap: the Dodgers ${summaries.join(", and ")} at home! Go Blue! Use code "DODGERSWIN" on the app for $7 Panda Plate.`,
  },
  {
    id: "lafc",
    getGames: getRecentFinishedHomeGames,
    filterHits: (g) => g.scoredFirstInFirstHalf,
    idOf: (hit) => hit.eventId,
    checkKeyPrefix: "lafc-notified",
    recapKeyPrefix: "lafc-recap",
    topics: lafcTopics,
    opsLabel: "lafc", // LAFC's ESPN source can fail in ways worth paging on — see alertOps() in jobs.js
    checkTitle: "⚽ LAFC Scores First!",
    recapTitle: "☀️ LAFC Morning Recap",
    buildMessage: (hit) =>
      `LAFC scored first in the first half! Final: ${hit.summary}. Use code "LAFCSCORES" at Ono Hawaiian BBQ tomorrow for a $5.99 chicken plate.`,
    buildSummary: (g) => `scored first against the ${g.opponent} (final: ${g.summary})`,
    buildRecapText: (summaries) =>
      summaries.length === 1
        ? `Morning reminder: LAFC ${summaries[0]} last night! Use code "LAFCSCORES" at Ono Hawaiian BBQ today for a $5.99 chicken plate.`
        : `Morning recap: LAFC ${summaries.join(", and ")}! Use code "LAFCSCORES" at Ono Hawaiian BBQ today for a $5.99 chicken plate.`,
  },
];
