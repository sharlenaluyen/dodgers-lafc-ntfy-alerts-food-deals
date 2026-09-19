// src/ntfy.js
// Thin wrapper around the ntfy pub/sub HTTP API. There's no subscriber
// list on our end — everyone who's subscribed to the topic in the ntfy app
// (or a browser) gets the notification the moment we publish once.
//
// NTFY_SERVER points at our own self-hosted instance (see wrangler.toml) —
// the public ntfy.sh's free-tier rate limiting is IP-based and shared
// across every Cloudflare Worker's egress IPs, which routinely exhausted
// our quota from unrelated traffic. NTFY_TOKEN is only needed if you switch
// back to a server that requires auth (the self-hosted instance doesn't).

export async function publish(env, message, { title } = {}) {
  const server = env.NTFY_SERVER || "https://ntfy.sh";
  const topic = env.NTFY_TOPIC || "ddbb-dodgers-panda-win";

  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;

  const res = await fetch(server, {
    method: "POST",
    headers,
    body: JSON.stringify({ topic, message, title }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ntfy publish failed: ${res.status} ${res.statusText} ${body}`);
  }
  return res.json();
}
