// test.js — a quick regression check, run with `npm test`.
// Simulates the Worker's `env` (a fake KV store + config) and injects fake
// `getRecentFinishedGames`/`getRecentFinishedHomeGames`/`publish` functions
// (no real network calls), then drives jobs.js through: a home win (should
// publish immediately), an away win (should NOT publish), a home loss
// (should NOT publish), a second home win the same run (doubleheader —
// publishes as its own message), and a repeated run (should NOT
// re-publish; KV flag is set). Also covers the LAFC/Ono jobs the same way,
// plus the ops-alert path for a broken ESPN integration (fetch failure and
// schema-change failure, each deduped on repeat).

import { checkAndNotify, sendMorningRecap, checkAndNotifyLAFC, sendMorningRecapLAFC } from "./src/jobs.js";

const mockGames = [
  {
    gamePk: 1001,
    isHomeGame: true,
    dodgersWon: true,
    opponent: "San Francisco Giants",
    dodgersScore: 5,
    opponentScore: 2,
    summary: "Dodgers 5, San Francisco Giants 2",
  },
  {
    // away win — should NOT trigger a publish
    gamePk: 1002,
    isHomeGame: false,
    dodgersWon: true,
    opponent: "Chicago Cubs",
    dodgersScore: 6,
    opponentScore: 1,
    summary: "Dodgers 6, Chicago Cubs 1",
  },
  {
    // home loss — should NOT trigger a publish
    gamePk: 1003,
    isHomeGame: true,
    dodgersWon: false,
    opponent: "New York Mets",
    dodgersScore: 1,
    opponentScore: 4,
    summary: "Dodgers 1, New York Mets 4",
  },
  {
    // second home win, same run — proves doubleheaders both publish (as separate messages)
    gamePk: 1004,
    isHomeGame: true,
    dodgersWon: true,
    opponent: "Los Angeles Angels",
    dodgersScore: 3,
    opponentScore: 1,
    summary: "Dodgers 3, Los Angeles Angels 1",
  },
];

const mockLafcGames = [
  {
    eventId: "9001",
    scoredFirstInFirstHalf: true,
    opponent: "Portland Timbers",
    lafcScore: 2,
    opponentScore: 1,
    summary: "LAFC 2, Portland Timbers 1",
  },
  {
    // scored, but not first / not in the first half — should NOT publish
    eventId: "9002",
    scoredFirstInFirstHalf: false,
    opponent: "Real Salt Lake",
    lafcScore: 1,
    opponentScore: 1,
    summary: "LAFC 1, Real Salt Lake 1",
  },
  {
    // second qualifying game, same run — proves multiple hits both publish
    eventId: "9003",
    scoredFirstInFirstHalf: true,
    opponent: "LA Galaxy",
    lafcScore: 3,
    opponentScore: 0,
    summary: "LAFC 3, LA Galaxy 0",
  },
];

function makeFakeKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

const env = { DODGERS_KV: makeFakeKv(), NTFY_TOPIC_LAFC: "test-lafc-topic", NTFY_OPS_TOPIC: "test-ops-topic" };

const published = [];
const deps = {
  getRecentFinishedGames: async () => mockGames,
  getRecentFinishedHomeGames: async () => mockLafcGames,
  publish: async (_env, message, opts) => {
    published.push({ message, title: opts && opts.title, topics: opts && opts.topics });
  },
};

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

console.log("=== Running checkAndNotify() ===");
await checkAndNotify(env, deps);
console.log(published);

assert(published.filter((m) => m.message.includes("WIN at home")).length === 2, "2 immediate publishes (2 home wins)");
assert(!published.some((m) => m.message.includes("Cubs")), "no message mentions the away win vs the Cubs");
assert(!published.some((m) => m.message.includes("Mets")), "no message mentions the home loss vs the Mets");

console.log("\n=== Running sendMorningRecap() ===");
published.length = 0;
await sendMorningRecap(env, deps);
console.log(published);

assert(published.length === 1, "morning recap published once (bundled into 1 message)");
assert(published[0].message.includes("Giants") && published[0].message.includes("Angels"), "bundled recap mentions both opponents");
assert(published[0].message.startsWith("Morning recap"), "uses the multi-win 'Morning recap' phrasing");

console.log("\n=== Running checkAndNotify() again (should be no-op; KV flags already set) ===");
published.length = 0;
await checkAndNotify(env, deps);
assert(published.length === 0, "second checkAndNotify run publishes nothing");

console.log("\n=== Running sendMorningRecap() again (should be no-op; KV flags already set) ===");
published.length = 0;
await sendMorningRecap(env, deps);
assert(published.length === 0, "second sendMorningRecap run publishes nothing");

console.log("\n=== Running checkAndNotifyLAFC() ===");
published.length = 0;
await checkAndNotifyLAFC(env, deps);
console.log(published);

assert(
  published.filter((m) => m.message.includes("scored first in the first half")).length === 2,
  "2 immediate publishes (2 qualifying games)"
);
assert(!published.some((m) => m.message.includes("Real Salt Lake")), "no message for the non-qualifying game");
assert(
  published.every((m) => m.topics && m.topics[0] === env.NTFY_TOPIC_LAFC),
  "LAFC publishes target the LAFC topic, not the Dodgers one"
);

console.log("\n=== Running sendMorningRecapLAFC() ===");
published.length = 0;
await sendMorningRecapLAFC(env, deps);
console.log(published);

assert(published.length === 1, "LAFC morning recap published once (bundled into 1 message)");
assert(
  published[0].message.includes("Timbers") && published[0].message.includes("Galaxy"),
  "bundled LAFC recap mentions both opponents"
);

console.log("\n=== Running checkAndNotifyLAFC() again (should be no-op; KV flags already set) ===");
published.length = 0;
await checkAndNotifyLAFC(env, deps);
assert(published.length === 0, "second checkAndNotifyLAFC run publishes nothing");

console.log("\n=== Running sendMorningRecapLAFC() again (should be no-op; KV flags already set) ===");
published.length = 0;
await sendMorningRecapLAFC(env, deps);
assert(published.length === 0, "second sendMorningRecapLAFC run publishes nothing");

console.log("\n=== Simulating a broken ESPN integration (fetch failure) ===");
published.length = 0;
const fetchBrokenDeps = {
  ...deps,
  getRecentFinishedHomeGames: async () => {
    const err = new Error("network unreachable");
    err.kind = "fetch";
    throw err;
  },
};
await checkAndNotifyLAFC(env, fetchBrokenDeps);
assert(published.length === 1, "a broken integration triggers exactly one ops alert");
assert(published[0].topics && published[0].topics[0] === env.NTFY_OPS_TOPIC, "ops alert targets the ops topic, not a promo topic");
assert(published[0].message.includes("fetch"), "ops alert message identifies the failure kind");

console.log("\n=== Running the same broken integration again (should be deduped) ===");
published.length = 0;
await checkAndNotifyLAFC(env, fetchBrokenDeps);
assert(published.length === 0, "a repeated failure of the same kind within the dedup window doesn't re-alert");

console.log("\n=== Simulating a schema change (a distinct failure kind) ===");
published.length = 0;
const schemaBrokenDeps = {
  ...deps,
  getRecentFinishedHomeGames: async () => {
    const err = new Error("summary.keyEvents missing or not an array");
    err.kind = "schema";
    throw err;
  },
};
await checkAndNotifyLAFC(env, schemaBrokenDeps);
assert(published.length === 1, "a distinct failure kind (schema vs fetch) still alerts, since it's keyed separately");

process.exit(process.exitCode || 0);
