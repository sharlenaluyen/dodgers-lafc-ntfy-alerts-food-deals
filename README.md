# Dodgers Win Alerts

Sends a push notification to every subscriber when the LA Dodgers win **at home** (Dodger Stadium) — once right away, and again as a bundled recap the next morning. Built on [ntfy.sh](https://ntfy.sh) (free, open-source pub/sub push notifications — no account, no per-subscriber cost) and the free MLB Stats API (no API key needed for scores).

Away wins and any loss are silently ignored — nobody gets notified about those.

## How it works

There's no subscriber database in this app. Everyone subscribes directly to one shared **ntfy topic** in the ntfy app (or a browser) — the server just publishes to that topic once, and ntfy fans it out to everyone listening. That also means there's no signup form to fill out and nothing here ever touches a phone number.

- **`server.js`** — Express app: serves the info page (`public/index.html`) telling people how to subscribe, exposes an admin test-notify endpoint, and wires up the two cron schedules from `jobs.js`.
- **`jobs.js`** — the two background jobs, kept separate so they're testable on their own:
  - `checkAndNotify()` — runs every 5 minutes (configurable). Looks for a Dodgers game that just went `Final`. If it was a **home win**, publishes to the ntfy topic immediately. Away wins and home losses are recorded (so they're never re-checked) but nothing is published.
  - `sendMorningRecap()` — runs once a day at 8:00 AM Pacific (configurable). Publishes one bundled message covering every home win since the last recap — so a doubleheader sweep is one notification, not two.
- **`mlb.js`** — polls `statsapi.mlb.com` (free, keyless) for the Dodgers' games in the last ~24h, and flags whether each finished game was (a) a win and (b) actually played at Dodger Stadium — see "How home games are detected" below.
- **`db.js`** — SQLite file (`data.sqlite`) holding a row per `gamePk` already evaluated (home/away, win/loss, and whether its morning recap has gone out yet), so nothing is ever double-published even with the checker running every 5 minutes.
- **`ntfy.js`** — publishes a message to the ntfy topic via a single HTTP POST. No subscriber list to loop over — one publish reaches everyone.
- **`test-jobs.js`** — `npm test` runs a mocked end-to-end pass (a home win, an away win, a home loss, and a second home win the same day) with no real network calls, and checks: only home wins publish immediately, the morning recap bundles multiple wins into one message, and both jobs are safe to re-run without double-publishing.

### How home games are detected

The MLB API's venue field for a Dodgers home game is currently `"UNIQLO Field at Dodger Stadium"` (the stadium has a naming-rights sponsor as of the 2026 season) rather than a plain `"Dodger Stadium"` — I checked the live API rather than assuming. The matcher looks for the substring `"dodger stadium"` (case-insensitive, configurable via `HOME_VENUE_MATCH` in `.env`), so it survives that kind of sponsor-name prefixing. If the venue is ever renamed to drop "Dodger Stadium" from it entirely, update `HOME_VENUE_MATCH` to match.

## 1. Pick a topic name

Anyone who knows the topic name can subscribe to it (or, on the public `ntfy.sh` server, publish to it too) — there's no per-subscriber auth. Treat it like a shared secret: long and unguessable, not something obvious like `dodgers-alerts`. This app defaults to:

```
NTFY_TOPIC=ddbb-dodgers-panda-win
```

Change it in `.env` if you want your own.

## 2. Configure this app

```bash
cd dodgers-sms-alerts
npm install
cp .env.example .env
```

Edit `.env` if you want to change the defaults:

```
NTFY_TOPIC=ddbb-dodgers-panda-win     # your shared topic name
NTFY_SERVER=https://ntfy.sh           # or your own self-hosted ntfy instance
ADMIN_SECRET=some-random-string       # protects the /admin/test-notify endpoint
```

Run it locally:

```bash
npm start
```

This starts the web server on `http://localhost:3000`, immediately runs one score check, then repeats every 5 minutes, plus a once-daily morning recap.

Run the automated check before deploying:

```bash
npm test
```

## 3. Subscribe to alerts

1. Install the free **ntfy** app: [iOS](https://apps.apple.com/us/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) — or subscribe straight from a browser at `https://ntfy.sh/<your-topic>` (no app install needed, works as a web push subscription).
2. In the app, tap **+** and enter your topic name (e.g. `ddbb-dodgers-panda-win`).
3. That's it — no phone number, no signup form, no account.

Share your app's `/` page (`public/index.html`) with people you want subscribed — it shows the topic name and links to both app stores plus the browser-subscribe option.

To unsubscribe, delete the topic from inside the ntfy app at any time.

## 4. Test it

With the server running and reachable:

- **Send yourself a one-off test notification** (doesn't touch any real game data):
  ```bash
  curl -X POST "https://your-app.example.com/admin/test-notify?secret=YOUR_ADMIN_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"title": "Test", "message": "Test from Dodgers alerts"}'
  ```
- **Force a score check manually** (useful during testing) — just restart the app, it checks on boot.
- **Confirm delivery directly against ntfy**, without your app at all:
  ```bash
  curl -d "Test message" https://ntfy.sh/YOUR_TOPIC
  ```

## 5. Deploy it somewhere that stays on 24/7

The app needs to run continuously to poll scores on a schedule (there's no incoming webhook to receive anymore — publishing is a simple outbound HTTP call). Any small always-on Node host works.

### Option A: Render.com (simplest)

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com) → *New → Web Service* → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add the same environment variables from your `.env` under *Environment*.
5. **Persistent storage matters here:** Render's free tier has an ephemeral filesystem, so `data.sqlite` (which tracks which games have already been processed) gets wiped on every redeploy or restart — harmless, but a restart right after a win could theoretically re-publish it. For anything beyond casual use, add a **Render Disk** (Render → your service → *Disks*, a few dollars/month) mounted at `/opt/render/project/src` (or update `db.js`'s `DB_PATH` to point at the mounted disk path).
6. Once live, copy the `https://your-app.onrender.com` URL into `PUBLIC_BASE_URL` in your env vars.

### Option B: Railway.app or Fly.io

Both support a `Dockerfile`-free Node deploy plus a persistent volume, similarly priced. General steps are the same as Render: connect the repo, set env vars, attach a volume for `data.sqlite`, set the start command to `npm start`.

### If you'd rather not depend on the public ntfy.sh

ntfy is open-source and self-hostable — run your own [ntfy server](https://docs.ntfy.sh/install/) (a single small Docker container) and point `NTFY_SERVER` at it instead of `https://ntfy.sh`. Subscribers then point their app at your server instead of the public one.

## Customizing

- **Different team:** change `MLB_TEAM_ID` in `.env` (Dodgers = `119`). Any MLB team ID works. You'd also want to update `HOME_VENUE_MATCH` to that team's home venue.
- **Away wins too:** if you decide you want away wins published as well, in `jobs.js` change `const shouldNotify = game.isHomeGame && game.dodgersWon;` to `const shouldNotify = game.dodgersWon;`.
- **Check frequency:** `CHECK_CRON` in `.env`, standard cron syntax (default: every 5 minutes).
- **Morning recap time:** `MORNING_CRON` and `MORNING_TZ` in `.env` (default: 8:00 AM `America/Los_Angeles`).
- **Message wording:** edit the `text` templates in `checkAndNotify()` and `sendMorningRecap()` in `jobs.js`.

## Privacy notes

- The public `ntfy.sh` server is free and requires no account, but messages pass through their infrastructure (retained ~12h, then deleted) and their iOS/Android apps deliver via Firebase Cloud Messaging (Google's push infrastructure) like virtually all mobile push notifications do. See [ntfy's privacy policy](https://docs.ntfy.sh/privacy/) for details, or self-host (Option "If you'd rather not depend on the public ntfy.sh" above) to avoid both.
- The topic name is the *only* access control — anyone who has it can subscribe, and on the public server, anyone who has it can publish to it too. Keep it unguessable rather than sharing it publicly if that matters to you.
