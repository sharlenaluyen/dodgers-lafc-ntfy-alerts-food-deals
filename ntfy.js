// ntfy.js
// Thin wrapper around the ntfy.sh pub/sub HTTP API. There's no subscriber
// list on our end — everyone who's subscribed to NTFY_TOPIC in the ntfy app
// (or a browser) gets the notification the moment we publish once.

const NTFY_SERVER = process.env.NTFY_SERVER || "https://ntfy.sh";
const NTFY_TOPIC = process.env.NTFY_TOPIC || "ddbb-dodgers-panda-win";

async function publish(message, { title } = {}) {
  const res = await fetch(NTFY_SERVER, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ topic: NTFY_TOPIC, message, title }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ntfy publish failed: ${res.status} ${res.statusText} ${body}`);
  }
  return res.json();
}

module.exports = { publish, NTFY_TOPIC, NTFY_SERVER };
