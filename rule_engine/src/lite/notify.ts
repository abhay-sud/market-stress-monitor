// "Run your own" notification channels. Each is enabled by its secrets and
// is a plain HTTPS call (no SDKs). Error messages never include a URL or
// token: on a public fork, the Actions log is public.

export interface Message {
  title: string;
  body: string;
  /** "high" for event alerts, "default" for the brief. */
  priority: "high" | "default";
}

export interface Channel {
  name: string;
  send(m: Message): Promise<void>;
}

type Env = Record<string, string | undefined>;

async function post(name: string, url: string, init: RequestInit): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error(`${name}: network error`);
  }
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
}

// ntfy puts the title in an HTTP header, which must be Latin-1.
const headerSafe = (s: string) => s.replace(/[^\x20-\x7e]/g, (c) => ({ "·": "-", "→": "->", "—": "-", "–": "-" })[c] ?? "");

/** Channels configured in `env`, in a fixed order. */
export function channelsFromEnv(env: Env): Channel[] {
  const out: Channel[] = [];
  const v = (k: string) => (env[k] ?? "").trim();

  if (v("NTFY_TOPIC")) {
    const server = (v("NTFY_SERVER") || "https://ntfy.sh").replace(/\/+$/, "");
    const email = v("ALERT_EMAIL");
    out.push({
      name: email ? "ntfy (+email)" : "ntfy",
      send: (m) =>
        post("ntfy", `${server}/${encodeURIComponent(v("NTFY_TOPIC"))}`, {
          method: "POST",
          headers: {
            Title: headerSafe(m.title),
            Priority: m.priority === "high" ? "high" : "default",
            Tags: m.priority === "high" ? "rotating_light" : "chart_with_downwards_trend",
            ...(email ? { Email: email } : {}),
          },
          body: m.body,
        }),
    });
  }
  if (v("TELEGRAM_BOT_TOKEN") && v("TELEGRAM_CHAT_ID")) {
    out.push({
      name: "Telegram",
      send: (m) =>
        post("Telegram", `https://api.telegram.org/bot${v("TELEGRAM_BOT_TOKEN")}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: v("TELEGRAM_CHAT_ID"), text: `${m.title}\n\n${m.body}`, disable_web_page_preview: true }),
        }),
    });
  }
  if (v("DISCORD_WEBHOOK_URL")) {
    out.push({
      name: "Discord",
      send: (m) =>
        post("Discord", v("DISCORD_WEBHOOK_URL"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `**${m.title}**\n${m.body}`.slice(0, 2000), allowed_mentions: { parse: [] } }),
        }),
    });
  }
  if (v("SLACK_WEBHOOK_URL")) {
    out.push({
      name: "Slack",
      send: (m) =>
        post("Slack", v("SLACK_WEBHOOK_URL"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `*${m.title}*\n${m.body}` }),
        }),
    });
  }
  return out;
}

/**
 * Sends to every channel. Throws only if every channel failed, so one broken
 * webhook doesn't stop the others; partial failures are returned for the log.
 */
export async function sendAll(channels: Channel[], m: Message): Promise<string[]> {
  const results = await Promise.allSettled(channels.map((c) => c.send(m)));
  const failures = results.flatMap((r, i) => (r.status === "rejected" ? [`${channels[i].name}: ${r.reason instanceof Error ? r.reason.message : "failed"}`] : []));
  if (channels.length && failures.length === channels.length) throw new Error(`every channel failed (${failures.join("; ")})`);
  return failures;
}
