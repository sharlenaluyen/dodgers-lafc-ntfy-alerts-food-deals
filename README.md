# Dodgers Win Alerts

Sends a push notification when the LA Dodgers win **at home** (Dodger Stadium): once right away, and again the next morning. Runs as a **Cloudflare Worker** on Cron Triggers (free, persistent, no server to keep running), publishes through [ntfy.sh](https://ntfy.sh) (free, open-source push; no account, no per-subscriber cost), and reads scores from the free MLB Stats API (no API key needed).

Away wins/losses are silently ignored.

## How it works

There's no subscriber database and no always-on server. Cloudflare's Cron Triggers call this Worker on a schedule; each run makes a couple of outbound HTTP calls and exits. Everyone subscribes directly to one shared **ntfy topic** (ddbb-dodgers-panda-win), and the Worker just publishes to it once, and ntfy send out a notification to subscribers.

There's also no game-history database. A tiny flag per game in **Workers KV** (Cloudflare's key-value store) is all that prevents a game from being announced twice. It expires on its own after 2 days, so nothing is kept around longer than that.

- **`src/index.js`** — the Worker entry. `scheduled()` runs on every Cron Trigger fire and dispatches to the right job; `fetch()` exposes a `/test-notify` route for manually verifying the ntfy path.
- **`src/jobs.js`** — the two jobs:
  - `checkAndNotify()` — looks for a Dodgers game that just went `Final`. If it was a **home win** and hasn't been flagged yet in KV, publishes to ntfy immediately and sets the flag.
  - `sendMorningRecap()` — bundles every home win found in the lookback window that hasn't had its recap flag set into one message (so a doubleheader sweep is one notification, not two).
- **`src/mlb.js`** — polls `statsapi.mlb.com` (free, keyless) for the Dodgers' games in the last ~24h, and flags whether each finished game was (a) a win and (b) actually played at Dodger Stadium — see "How home games are detected" below.
- **`src/ntfy.js`** — publishes a message to the ntfy topic via a single HTTP POST.
- **`test.js`** — `npm test` runs a mocked pass (a home win, an away win, a home loss, and a second home win the same run) with fake KV storage and no real network calls, and checks: only home wins publish, the morning recap bundles multiple wins into one message, and both jobs are safe to re-run without double-publishing.
- **`wrangler.toml`** — Worker config: the Cron Trigger schedule, non-secret vars, and the KV namespace binding.

### How home games are detected

The MLB API's venue field for a Dodgers home game is currently `"UNIQLO Field at Dodger Stadium"` (the stadium has a naming-rights sponsor as of the 2026 season) rather than a plain `"Dodger Stadium"` — checked against the live API rather than assumed. The matcher looks for the substring `"dodger stadium"` (case-insensitive, configurable via `HOME_VENUE_MATCH` in `wrangler.toml`), so it survives that kind of sponsor-name prefixing.

### Why the check only runs part of the day

Checking every 15 minutes, 24/7, all season would burn through free-tier budgets unnecessarily and just isn't useful overnight when there's no game. Instead, `wrangler.toml`'s Cron Triggers only fire every 15 minutes from roughly 1:00 PM to 11:45 PM Pacific (the realistic window for a Dodgers game to be in progress or wrapping up) plus once daily at 8:00 AM Pacific for the recap. See the comment above `[triggers]` in `wrangler.toml` for the UTC math and a note on the Daylight/Standard Time caveat.

## 1. Pick a topic name

Anyone who knows the ntfy topic name can subscribe to it (or, on the public `ntfy.sh` server, publish to it too) — there's no per-subscriber auth. Treat it like a shared secret: long and unguessable. This app defaults to:

```
NTFY_TOPIC = "ddbb-dodgers-panda-win"
```

set in `wrangler.toml`'s `[vars]`. Change it there if you want your own.

## 2. Set up

```bash
cd dodgers-sms-alerts
npm install
cp .dev.vars.example .dev.vars   # local-dev secret override, gitignored
```

Log in to Cloudflare (one-time, browser-based):

```bash
npx wrangler login
```

Create the KV namespace this app uses for its dedup flags, then paste the printed `id` into `wrangler.toml`'s `[[kv_namespaces]]` block (replacing the placeholder):

```bash
npx wrangler kv namespace create DODGERS_KV
```

Set the admin secret (protects `/test-notify`) as a real Cloudflare secret, not a plain var:

```bash
npx wrangler secret put ADMIN_SECRET
```

Run the automated check:

```bash
npm test
```

Run it locally against real Cloudflare infra (KV included) before deploying:

```bash
npm run dev
```

## 3. Deploy

```bash
npm run deploy
```

That registers the Worker and its Cron Triggers with Cloudflare — no server to host, nothing to keep running yourself. To redeploy after a change, just run it again (or connect the repo in the Cloudflare dashboard under **Workers & Pages → your Worker → Settings → Builds** for git-push-to-deploy).

## 4. Subscribe to alerts

1. Install the free **ntfy** app: [iOS](https://apps.apple.com/us/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) — or subscribe straight from a browser at `https://ntfy.sh/<your-topic>` (no app install needed).
2. In the app, tap **+** and enter your topic name (e.g. `ddbb-dodgers-panda-win`).
3. That's it — no phone number, no signup form, no account.

`public/index.html` is a static page with the topic name, app-store links, and the browser-subscribe link — host it wherever you like (e.g. Cloudflare Pages on a domain you already own) and share that link with people you want subscribed. It's independent of the Worker; nothing here serves it automatically.

To unsubscribe, delete the topic from inside the ntfy app at any time.

## 5. Test it

- **Send a one-off test notification** (doesn't touch any real game data):
  ```bash
  curl "https://your-worker.your-subdomain.workers.dev/test-notify?secret=YOUR_ADMIN_SECRET"
  ```
- **Confirm delivery directly against ntfy**, without the Worker at all:
  ```bash
  curl -d "Test message" https://ntfy.sh/YOUR_TOPIC
  ```
- **Check the Cron Trigger fired**: Cloudflare dashboard → your Worker → **Logs**, or `npx wrangler tail`.

## If you'd rather not depend on the public ntfy.sh

ntfy is open-source and self-hostable — run your own [ntfy server](https://docs.ntfy.sh/install/) (a single small Docker container somewhere) and point `NTFY_SERVER` in `wrangler.toml` at it instead of `https://ntfy.sh`. Subscribers then point their app at your server instead of the public one.

## Customizing

- **Different team:** change `MLB_TEAM_ID` in `wrangler.toml` (Dodgers = `119`). Any MLB team ID works. You'd also want to update `HOME_VENUE_MATCH` to that team's home venue.
- **Away wins too:** in `src/jobs.js`, change `g.isHomeGame && g.dodgersWon` to just `g.dodgersWon` in both `checkAndNotify()` and `sendMorningRecap()`.
- **Check frequency/window:** edit the `crons` array in `wrangler.toml` (standard cron syntax, UTC only).
- **Message wording:** edit the text templates in `src/jobs.js`.

## Privacy notes

- The public `ntfy.sh` server is free and requires no account, but messages pass through their infrastructure (retained ~12h, then deleted) and their iOS/Android apps deliver via Firebase Cloud Messaging (Google's push infrastructure), like virtually all mobile push notifications do. See [ntfy's privacy policy](https://docs.ntfy.sh/privacy/) for details, or self-host (see above) to avoid both.
- The topic name is the *only* access control — anyone who has it can subscribe, and on the public server, anyone who has it can publish to it too. Keep it unguessable rather than sharing it publicly if that matters to you.
