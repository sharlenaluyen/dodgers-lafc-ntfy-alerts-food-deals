// src/ntfy.js
// Thin wrapper around the ntfy pub/sub HTTP API. There's no subscriber
// list on our end — everyone who's subscribed to the topic in the ntfy app
// (or a browser) gets the notification the moment we publish once.
//
// NTFY_SERVER points at our own self-hosted instance (see wrangler.toml) —
// the public ntfy.sh's free-tier rate limiting is IP-based and shared
// across every Cloudflare Worker's egress IPs, which routinely exhausted
// our quota from unrelated traffic. Our own instance has no auth, so no
// token is needed here.

export async function publish(env, message, { title, topics } = {}) {
  const server = env.NTFY_SERVER || "https://ntfy.sh";
  // Explicit `topics` (e.g. the LAFC or ops alert topic) overrides the
  // default Dodgers topic(s) entirely rather than adding to them — those
  // are separate audiences that shouldn't cross-post to each other.
  const targetTopics = topics || [env.NTFY_TOPIC || "ddbb-dodgers-panda-win", env.NTFY_TOPIC_PUBLIC].filter(Boolean);

  return Promise.all(
    targetTopics.map(async (topic) => {
      const res = await fetch(server, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ topic, message, title }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ntfy publish failed (topic=${topic}): ${res.status} ${res.statusText} ${body}`);
      }
      return res.json();
    })
  );
}
