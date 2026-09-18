// test-jobs.js — a quick regression check, run with `npm test`.
// Mocks the MLB API response and the ntfy publish call (no real network
// happens), then drives jobs.js through: a home win (should publish
// immediately), an away win (should NOT publish), a home loss (should NOT
// publish), and a second home win the same run (to prove doubleheaders bundle
// into one morning message instead of two).

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "data.sqlite");
for (const f of [DB_FILE, DB_FILE + "-wal", DB_FILE + "-shm"]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// --- mock fetch: three finished games in the lookback window ---
const mockGames = [
  {
    gamePk: 1001,
    gameDate: "2026-08-10T02:10:00Z",
    officialDate: "2026-08-09",
    status: { abstractGameState: "Final" },
    venue: { name: "UNIQLO Field at Dodger Stadium" },
    teams: {
      home: { team: { id: 119, name: "Los Angeles Dodgers" }, score: 5, isWinner: true },
      away: { team: { id: 137, name: "San Francisco Giants" }, score: 2, isWinner: false },
    },
  },
  {
    // away win — should NOT trigger a publish
    gamePk: 1002,
    gameDate: "2026-08-11T00:10:00Z",
    officialDate: "2026-08-10",
    status: { abstractGameState: "Final" },
    venue: { name: "Wrigley Field" },
    teams: {
      home: { team: { id: 112, name: "Chicago Cubs" }, score: 1, isWinner: false },
      away: { team: { id: 119, name: "Los Angeles Dodgers" }, score: 6, isWinner: true },
    },
  },
  {
    // home loss — should NOT trigger a publish
    gamePk: 1003,
    gameDate: "2026-08-12T02:10:00Z",
    officialDate: "2026-08-11",
    status: { abstractGameState: "Final" },
    venue: { name: "UNIQLO Field at Dodger Stadium" },
    teams: {
      home: { team: { id: 119, name: "Los Angeles Dodgers" }, score: 1, isWinner: false },
      away: { team: { id: 121, name: "New York Mets" }, score: 4, isWinner: true },
    },
  },
  {
    // second home win, same run — proves doubleheader-style bundling into one morning message
    gamePk: 1004,
    gameDate: "2026-08-12T20:10:00Z",
    officialDate: "2026-08-12",
    status: { abstractGameState: "Final" },
    venue: { name: "UNIQLO Field at Dodger Stadium" },
    teams: {
      home: { team: { id: 119, name: "Los Angeles Dodgers" }, score: 3, isWinner: true },
      away: { team: { id: 108, name: "Los Angeles Angels" }, score: 1, isWinner: false },
    },
  },
];

global.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ dates: [{ games: mockGames }] }),
});

const db = require("./db");

// --- stub the ntfy publish path so no real network call happens ---
const ntfy = require("./ntfy");
const published = [];
ntfy.publish = async (message, opts) => {
  published.push({ message, title: opts && opts.title });
  return { id: "mock-id" };
};

const jobs = require("./jobs");

(async () => {
  console.log("=== Running checkAndNotify() ===");
  await jobs.checkAndNotify();

  console.log("\n--- Published so far (immediate) ---");
  console.log(published);

  const assert = (cond, msg) => {
    if (!cond) {
      console.error("FAIL:", msg);
      process.exitCode = 1;
    } else {
      console.log("PASS:", msg);
    }
  };

  // Each home win publishes once — 2 home wins = 2 immediate publishes.
  assert(published.filter((m) => m.message.includes("WIN at home")).length === 2, "2 total immediate publishes (2 home wins)");
  assert(!published.some((m) => m.message.includes("6, ") || m.message.includes("Cubs")), "no message mentions the away win vs the Cubs");
  assert(!published.some((m) => m.message.includes("Mets")), "no message mentions the home loss vs the Mets");

  console.log("\n=== Running sendMorningRecap() ===");
  published.length = 0;
  await jobs.sendMorningRecap();
  console.log("\n--- Morning recap publishes ---");
  console.log(published);

  assert(published.length === 1, "morning recap published once (bundled into 1 message)");
  assert(published.every((m) => m.message.includes("Giants") && m.message.includes("Angels")), "bundled morning recap mentions both opponents (Giants + Angels)");
  assert(published.every((m) => m.message.startsWith("Morning recap")), "uses the multi-win 'Morning recap' phrasing, not the single-win one");

  console.log("\n=== Running sendMorningRecap() again (should be no-op, already sent) ===");
  published.length = 0;
  await jobs.sendMorningRecap();
  assert(published.length === 0, "second morning recap run publishes nothing (idempotent)");

  console.log("\n=== Running checkAndNotify() again (should be no-op, all games already processed) ===");
  published.length = 0;
  await jobs.checkAndNotify();
  assert(published.length === 0, "second checkAndNotify run publishes nothing (idempotent)");

  process.exit(process.exitCode || 0);
})();
