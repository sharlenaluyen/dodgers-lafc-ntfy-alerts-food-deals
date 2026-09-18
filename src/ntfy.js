// src/ntfy.js
// Thin wrapper around the ntfy.sh pub/sub HTTP API. There's no subscriber
// list on our end — everyone who's subscribed to the topic in the ntfy app
// (or a browser) gets the notification the moment we publish once.

export async function publish(env, message, { title } = {}) {
  const server = env.NTFY_SERVER || "https://ntfy.sh";
  const topic = env.NTFY_TOPIC || "ddbb-dodgers-panda-win";

  const res = await fetch(server, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ topic, message, title }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ntfy publish failed: ${res.status} ${res.statusText} ${body}`);
  }
  return res.json();
}
