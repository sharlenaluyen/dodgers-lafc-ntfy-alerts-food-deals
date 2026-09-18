// test.js — a quick regression check, run with `npm test`.
// Simulates the Worker's `env` (a fake KV store + config) and injects fake
// `getRecentFinishedGames`/`publish` functions (no real network calls),
// then drives jobs.js through: a home win (should publish immediately), an
// away win (should NOT publish), a home loss (should NOT publish), a
// second home win the same run (doubleheader — publishes as its own
// message), and a repeated run (should NOT re-publish; KV flag is set).

import { checkAndNotify, sendMorningRecap } from "./src/jobs.js";

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

const env = { DODGERS_KV: makeFakeKv() };

const published = [];
const deps = {
  getRecentFinishedGames: async () => mockGames,
  publish: async (_env, message, opts) => {
    published.push({ message, title: opts && opts.title });
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

process.exit(process.exitCode || 0);
