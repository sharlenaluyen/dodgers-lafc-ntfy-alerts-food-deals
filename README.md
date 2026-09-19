# Dodgers Win Alerts

Sends a push notification when the LA Dodgers win **at home** (Dodger Stadium): once right away, and again the next morning. Runs as a **Cloudflare Worker** on Cron Triggers (free, persistent, no server to keep running), publishes through a **self-hosted ntfy instance on Google Cloud Run** (free tier, open-source push — no account, no per-subscriber cost), and reads scores from the free MLB Stats API (no API key needed).

Away wins/losses are silently ignored.

## How it works

There's no subscriber database and no always-on server for the checking/scheduling side. Cloudflare's Cron Triggers call this Worker on a schedule; each run makes a couple of outbound HTTP calls and exits. Everyone subscribes directly to one shared **ntfy topic** (`ddbb-dodgers-panda-win`) on our own ntfy server, and the Worker just publishes to it once — ntfy sends the notification out to everyone subscribed.

There's also no game-history database. A tiny flag per game in **Workers KV** (Cloudflare's key-value store) is all that prevents a game from being announced twice. It expires on its own after 2 days, so nothing is kept around longer than that.

- **`src/index.js`** — the Worker entry. `scheduled()` runs on every Cron Trigger fire and dispatches to the right job; `fetch()` exposes a `/test-notify` route for manually verifying the ntfy path.
- **`src/jobs.js`** — the two jobs:
  - `checkAndNotify()` — looks for a Dodgers game that just went `Final`. If it was a **home win** and hasn't been flagged yet in KV, publishes to ntfy immediately and sets the flag.
  - `sendMorningRecap()` — bundles every home win found in the lookback window that hasn't had its recap flag set into one message (so a doubleheader sweep is one notification, not two).
- **`src/mlb.js`** — polls `statsapi.mlb.com` (free, keyless) for the Dodgers' games in the last ~24h, and flags whether each finished game was (a) a win and (b) actually played at Dodger Stadium — see "How home games are detected" below.
- **`src/ntfy.js`** — publishes a message to the ntfy topic via a single HTTP POST.
- **`test.js`** — `npm test` runs a mocked pass (a home win, an away win, a home loss, and a second home win the same run) with fake KV storage and no real network calls, and checks: only home wins publish, the morning recap bundles multiple wins into one message, and both jobs are safe to re-run without double-publishing.
- **`wrangler.toml`** — Worker config: the Cron Trigger schedule, non-secret vars (including the ntfy server URL), and the KV namespace binding.

### Why ntfy is self-hosted instead of using the public ntfy.sh

The public `ntfy.sh` server's free tier rate-limits by **IP address**, not by account — even an authenticated free account still shares that IP-based bucket (only paid ntfy tiers get their own dedicated quota). Since this Worker's outbound requests egress from Cloudflare's shared IP pool — used by countless other unrelated Workers also publishing to ntfy.sh — our tiny 1-2-messages-a-day usage routinely got caught in a `429 daily quota reached` triggered by *other people's* traffic, silently dropping real notifications. Full writeup: [ntfy issue #1963](https://github.com/binwiederhier/ntfy/issues/1963).

The fix was self-hosting a dedicated ntfy instance ([Google Cloud Run](https://cloud.google.com/run), free tier — 2M requests/month, far more than this needs) so our traffic isn't sharing anyone else's quota. See "Self-hosting ntfy" below for how it's deployed.

### How home games are detected

The MLB API's venue field for a Dodgers home game is currently `"UNIQLO Field at Dodger Stadium"` (the stadium has a naming-rights sponsor as of the 2026 season) rather than a plain `"Dodger Stadium"` — checked against the live API rather than assumed. The matcher looks for the substring `"dodger stadium"` (case-insensitive, configurable via `HOME_VENUE_MATCH` in `wrangler.toml`), so it survives that kind of sponsor-name prefixing.

### Why the check only runs part of the day

Checking every 15 minutes, 24/7, all season would burn through free-tier budgets unnecessarily and just isn't useful overnight when there's no game. Instead, `wrangler.toml`'s Cron Triggers only fire every 15 minutes from roughly 1:00 PM to 11:45 PM Pacific (the realistic window for a Dodgers game to be in progress or wrapping up) plus once daily at 8:00 AM Pacific for the recap. See the comment above `[triggers]` in `wrangler.toml` for the UTC math and a note on the Daylight/Standard Time caveat.

## 1. Pick a topic name

Anyone who knows the ntfy topic name (and our server address) can subscribe to it — there's no per-subscriber auth. Treat the topic name like a shared secret: long and unguessable. This app defaults to:

```
NTFY_TOPIC = "ddbb-dodgers-panda-win"
```

set in `wrangler.toml`'s `[vars]`. Change it there if you want your own.

## 2. Self-hosting ntfy (Google Cloud Run)

This only needs to be done once. It's deployed as:

```bash
gcloud auth login
gcloud projects create YOUR_PROJECT_ID --name="Dodgers ntfy"
# Attach a billing account to the project in the Cloud Console — required by
# Cloud Run even though usage stays within the free tier:
#   https://console.cloud.google.com/billing/linkedaccount?project=YOUR_PROJECT_ID
gcloud services enable run.googleapis.com --project=YOUR_PROJECT_ID

# First deploy (no base-url yet, since we don't know the assigned URL until after this):
gcloud run deploy dodgers-ntfy \
  --image=docker.io/binwiederhier/ntfy:latest \
  --region=us-west1 --platform=managed --allow-unauthenticated \
  --port=80 --args=serve --min-instances=0 --max-instances=1 \
  --project=YOUR_PROJECT_ID
# Note the printed Service URL, then redeploy with base-url/upstream-base-url set
# (ntfy requires base-url whenever upstream-base-url is set; upstream-base-url
# relays the "wake up and check" signal for iOS push through ntfy.sh's own
# Firebase/APNs setup — Apple doesn't allow a persistent background connection
# the way Android does, so even self-hosted instances need this for iOS):
gcloud run deploy dodgers-ntfy \
  --image=docker.io/binwiederhier/ntfy:latest \
  --region=us-west1 --platform=managed --allow-unauthenticated \
  --port=80 --args=serve --min-instances=0 --max-instances=1 \
  --set-env-vars="NTFY_BASE_URL=<the Service URL from above>,NTFY_UPSTREAM_BASE_URL=https://ntfy.sh" \
  --project=YOUR_PROJECT_ID
```

Then set `NTFY_SERVER` in `wrangler.toml`'s `[vars]` to that Service URL.

Cloud Run's free tier (2M requests/month) covers this easily — a tiny cron-triggered app publishing at most a couple of messages a day. `min-instances=0` means it scales to zero and cold-starts on the next request, which just means a brief delay before a notification relays; fine for this use case.

**A gotcha to know about if you redeploy:** `gcloud run deploy` without `--set-env-vars` reuses the *previous* revision's env vars rather than clearing them — pass `--clear-env-vars` explicitly if you want a clean slate.

**A gotcha to know about the billing account:** a brand-new Google Cloud account gets a one-time 90-day, $300 Free Trial — separate from, and shorter than, Cloud Run's *permanent* free tier used above. When the trial ends, Google auto-*stops* every resource on that billing account (not just starts charging) unless you've clicked **Upgrade** on it first, at [console.cloud.google.com/billing](https://console.cloud.google.com/billing). Upgrading doesn't cost anything for a workload this small — it only removes the trial's hard cutoff, since Cloud Run's own free allowance still applies afterward regardless of trial status.

## 3. Set up the Worker

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

## 4. Deploy the Worker

```bash
npm run deploy
```

That registers the Worker and its Cron Triggers with Cloudflare — no server to host, nothing to keep running yourself. To redeploy after a change, just run it again (or connect the repo in the Cloudflare dashboard under **Workers & Pages → your Worker → Settings → Builds** for git-push-to-deploy).

## 5. Subscribe to alerts

1. Install the free **ntfy** app: [iOS](https://apps.apple.com/us/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy).
2. Tap **+**, then **"Use a different server"** and enter our server's URL (the same one set in `NTFY_SERVER`) — this is the one extra step versus using the public ntfy.sh, since we're on our own instance.
3. Enter the topic name (e.g. `ddbb-dodgers-panda-win`).
4. That's it — no phone number, no signup form, no account. You can also subscribe straight from a browser at `<your-server-url>/<topic>`, no app install needed.

`public/index.html` is a static page with the server URL, topic name, app-store links, and the browser-subscribe link, with copy buttons for both — host it wherever you like (e.g. Cloudflare Pages on a domain you already own) and share that link with people you want subscribed. It's independent of the Worker; nothing here serves it automatically.

To unsubscribe, delete the topic from inside the ntfy app at any time.

## 6. Test it

- **Send a one-off test notification** (doesn't touch any real game data):
  ```bash
  curl "https://your-worker.your-subdomain.workers.dev/test-notify?secret=YOUR_ADMIN_SECRET"
  ```
- **Confirm delivery directly against your ntfy server**, without the Worker at all:
  ```bash
  curl -d "Test message" https://your-ntfy-server.run.app/YOUR_TOPIC
  ```
- **Check the Cron Trigger fired**: Cloudflare dashboard → your Worker → **Logs**, or `npx wrangler tail`.
- **Check the ntfy server's own logs**: `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="dodgers-ntfy"' --project=YOUR_PROJECT_ID`.

## Customizing

- **Different team:** change `MLB_TEAM_ID` in `wrangler.toml` (Dodgers = `119`). Any MLB team ID works. You'd also want to update `HOME_VENUE_MATCH` to that team's home venue.
- **Away wins too:** in `src/jobs.js`, change `g.isHomeGame && g.dodgersWon` to just `g.dodgersWon` in both `checkAndNotify()` and `sendMorningRecap()`.
- **Check frequency/window:** edit the `crons` array in `wrangler.toml` (standard cron syntax, UTC only).
- **Message wording:** edit the text templates in `src/jobs.js`.

## Privacy notes

- Since ntfy is self-hosted here, messages never touch the public `ntfy.sh` infrastructure except for the lightweight iOS "wake up and check" relay signal (`NTFY_UPSTREAM_BASE_URL`) — the actual message content is served from our own Cloud Run instance. See [ntfy's privacy policy](https://docs.ntfy.sh/privacy/) for what that relay involves.
- The topic name (plus knowing our server address) is the *only* access control — anyone who has both can subscribe, and since `--allow-unauthenticated` is set, anyone who has both can publish to it too. Keep the topic name unguessable rather than sharing it publicly if that matters to you.
