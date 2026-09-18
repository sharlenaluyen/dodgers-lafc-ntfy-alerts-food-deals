// server.js
// Entry point: an info page telling people how to subscribe via ntfy, an
// admin test-notify endpoint, and a cron job that polls MLB scores and
// publishes to the ntfy topic the moment a Dodgers home win goes final.

require("dotenv").config();

const path = require("path");
const express = require("express");
const cron = require("node-cron");

const { checkAndNotify, sendMorningRecap, getLocalHour } = require("./jobs");
const { publish, NTFY_TOPIC } = require("./ntfy");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Manual trigger to publish a test notification, so you can verify the send
// path works before relying on the cron job.
app.post("/admin/test-notify", async (req, res) => {
  if (!ADMIN_SECRET || req.query.secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  try {
    await publish(req.body.message || "Test notification from Dodgers alerts.", {
      title: req.body.title || "Dodgers Alerts Test",
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Background jobs (see jobs.js): an immediate check for a finished home win,
// on a tight interval, and a once-daily morning recap of the night before.
// ---------------------------------------------------------------------------
const cronExpr = process.env.CHECK_CRON || "*/5 * * * *";
cron.schedule(cronExpr, () => {
  checkAndNotify().catch((err) => console.error("[cron] unexpected error:", err));
});
console.log(`Score checker scheduled: "${cronExpr}"`);

const morningCronExpr = process.env.MORNING_CRON || "0 8 * * *";
const morningTz = process.env.MORNING_TZ || "America/Los_Angeles";
cron.schedule(
  morningCronExpr,
  () => {
    sendMorningRecap().catch((err) => console.error("[morning cron] unexpected error:", err));
  },
  { timezone: morningTz }
);
console.log(`Morning recap scheduled: "${morningCronExpr}" (${morningTz})`);

// Cron hour, parsed from "M H * * *" (defaults to 8 if the expression is unusual).
const morningHour = Number(morningCronExpr.split(/\s+/)[1]);
const MORNING_HOUR = Number.isFinite(morningHour) ? morningHour : 8;

// Run the win-check once at boot so a restart doesn't wait a full cycle to catch up.
checkAndNotify().catch((err) => console.error("[startup check] error:", err));

// Only catch up on the morning recap at boot if it's actually past the
// scheduled morning hour — otherwise a same-day restart (e.g. a deploy at
// 9pm) would fire the "morning" notification that same night instead of
// waiting for the real next-morning cron run.
if (getLocalHour(morningTz) >= MORNING_HOUR) {
  sendMorningRecap().catch((err) => console.error("[startup morning check] error:", err));
}

app.listen(PORT, () => {
  console.log(`Dodgers ntfy alerts server listening on port ${PORT}`);
  console.log(`Publishing to ntfy topic: "${NTFY_TOPIC}"`);
});
