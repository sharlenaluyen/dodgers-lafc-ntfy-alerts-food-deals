// src/mls.js
// Polls ESPN's unofficial soccer API (undocumented, keyless — same "free
// but unsupported" trade-off as statsapi.mlb.com in mlb.js) for LAFC's
// games, and reports back any finished HOME games in roughly the last 24h,
// including whether LAFC scored the match's first goal within the first
// half — the trigger condition for Ono Hawaiian BBQ's "LAFCSCORES" promo.
//
// Unlike mlb.js, failures here are treated as first-class outcomes rather
// than left to crash the scheduled run: thrown errors carry an `err.kind`
// of "fetch" (the request itself failed) or "schema" (ESPN responded, but
// the JSON didn't look like what this code expects) so jobs.js can turn
// either into a one-time ops alert instead of silently going dark.

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1";

function fetchError(message) {
  const err = new Error(message);
  err.kind = "fetch";
  return err;
}

function schemaError(message) {
  const err = new Error(message);
  err.kind = "schema";
  return err;
}

async function fetchJson(url, label) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw fetchError(`${label}: network error: ${err.message}`);
  }
  if (!res.ok) {
    throw fetchError(`${label}: HTTP ${res.status} ${res.statusText}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw fetchError(`${label}: response wasn't valid JSON: ${err.message}`);
  }
}

// Did LAFC score the match's first (non-shootout) goal, in the first half?
// `keyEvents` is usually already chronological, but it's sorted by clock
// value here defensively rather than trusting that ordering.
function scoredFirstInFirstHalf(summary, teamId) {
  if (!Array.isArray(summary.keyEvents)) {
    throw schemaError("summary.keyEvents missing or not an array");
  }

  const goals = summary.keyEvents.filter((e) => e && e.scoringPlay === true && e.shootout !== true);
  for (const goal of goals) {
    if (typeof goal.team?.id !== "string" || typeof goal.period?.number !== "number") {
      throw schemaError("a scoring keyEvent is missing team.id or period.number");
    }
  }
  if (goals.length === 0) return false; // 0-0 — nobody scored first

  goals.sort((a, b) => (a.clock?.value ?? 0) - (b.clock?.value ?? 0));
  const first = goals[0];
  return first.team.id === teamId && first.period.number === 1;
}

export async function getRecentFinishedHomeGames(env) {
  const teamId = String(env.ESPN_LAFC_TEAM_ID || "18966");
  const now = new Date();
  const lookbackMs = 24 * 60 * 60 * 1000;

  const schedule = await fetchJson(`${ESPN_BASE}/teams/${teamId}/schedule`, "ESPN schedule");
  if (!Array.isArray(schedule.events)) {
    throw schemaError("schedule.events missing or not an array");
  }

  const results = [];
  for (const event of schedule.events) {
    const comp = event.competitions?.[0];
    if (!comp) throw schemaError(`event ${event.id}: missing competitions[0]`);

    const statusType = comp.status?.type;
    if (!statusType || typeof statusType.completed !== "boolean") {
      throw schemaError(`event ${event.id}: missing status.type.completed`);
    }
    if (!statusType.completed) continue; // not finished yet

    const gameDate = new Date(event.date);
    if (Number.isNaN(gameDate.getTime()) || now - gameDate > lookbackMs) continue; // outside lookback

    if (!Array.isArray(comp.competitors)) {
      throw schemaError(`event ${event.id}: missing competitors`);
    }
    const lafc = comp.competitors.find((c) => c.team?.id === teamId);
    const opponent = comp.competitors.find((c) => c.team?.id && c.team.id !== teamId);
    if (!lafc || !opponent) throw schemaError(`event ${event.id}: couldn't identify both competitors`);

    const isHomeGame = lafc.homeAway === "home" && comp.neutralSite !== true;
    if (!isHomeGame) continue; // away/neutral-site — promo requires a home match

    const summary = await fetchJson(`${ESPN_BASE}/summary?event=${event.id}`, `ESPN summary (event ${event.id})`);
    const scoredFirst = scoredFirstInFirstHalf(summary, teamId);

    const lafcScore = lafc.score?.value;
    const opponentScore = opponent.score?.value;
    const opponentName = opponent.team?.displayName || "their opponent";

    results.push({
      eventId: event.id,
      gameDate: event.date,
      scoredFirstInFirstHalf: scoredFirst,
      opponent: opponentName,
      lafcScore,
      opponentScore,
      summary: `LAFC ${lafcScore}, ${opponentName} ${opponentScore}`,
    });
  }
  return results;
}
