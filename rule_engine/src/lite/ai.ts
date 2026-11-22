// "Run your own": the optional AI paragraph appended to the daily brief.
// Off unless an AI key is set. The model gets the day's computed facts as
// JSON and is told to explain them, not to change them; "the LLM never does
// the numbers" is enforced in code: every number in the reply must appear in
// the facts, or the paragraph is dropped and the brief goes out without it.
// Same on any refusal, truncation or provider error. Plain HTTPS, no SDKs
// (one module, three provider shapes; spec decision 2026-11-21).

import type { DayState } from "./replay.js";
import { INDICATORS, riskBandSentence } from "./events.js";

type Env = Record<string, string | undefined>;

export interface AiProvider {
  name: "anthropic" | "gemini" | "openai-compatible";
  model: string;
  complete(system: string, user: string): Promise<string>;
}

const TIMEOUT_MS = 30_000;
const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5-5";

async function postJson(label: string, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctl.signal });
  } catch {
    throw new Error(`${label}: network error or timeout`);
  } finally {
    clearTimeout(timer);
  }
  // Never echo the URL or headers: they can carry the key.
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}

/** The configured provider (Anthropic, then Gemini, then OpenAI-compatible), or null when no AI key is set. */
export function aiProviderFromEnv(env: Env): AiProvider | null {
  const v = (k: string) => (env[k] ?? "").trim();
  const model = v("AI_MODEL");

  if (v("ANTHROPIC_API_KEY")) {
    const m = model || ANTHROPIC_DEFAULT_MODEL;
    return {
      name: "anthropic",
      model: m,
      async complete(system, user) {
        // On the default model, a safety-classifier decline is retried on a
        // fallback model server-side (fallbacks: "default").
        const fallback = m === ANTHROPIC_DEFAULT_MODEL;
        const r = await postJson(
          "Anthropic",
          "https://api.anthropic.com/v1/messages",
          {
            "x-api-key": v("ANTHROPIC_API_KEY"),
            "anthropic-version": "2026-10-21",
            ...(fallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
          },
          {
            model: m,
            max_tokens: 4000,
            output_config: { effort: "low" },
            system,
            messages: [{ role: "user", content: user }],
            ...(fallback ? { fallbacks: "default" } : {}),
          },
        );
        if (r.stop_reason !== "end_turn") throw new Error(`Anthropic: stopped (${r.stop_reason})`);
        return (r.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      },
    };
  }

  if (v("GEMINI_API_KEY")) {
    if (!model) throw new Error("GEMINI_API_KEY is set but AI_MODEL isn't: set the AI_MODEL variable to a Gemini model name");
    return {
      name: "gemini",
      model,
      async complete(system, user) {
        const r = await postJson(
          "Gemini",
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          { "x-goog-api-key": v("GEMINI_API_KEY") },
          { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }] },
        );
        const cand = r.candidates?.[0];
        if (cand?.finishReason !== "STOP") throw new Error(`Gemini: stopped (${cand?.finishReason ?? "no candidate"})`);
        return (cand.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
      },
    };
  }

  if (v("OPENAI_API_KEY")) {
    if (!model) throw new Error("OPENAI_API_KEY is set but AI_MODEL isn't: set the AI_MODEL variable to the provider's model name");
    const base = (v("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
    return {
      name: "openai-compatible",
      model,
      async complete(system, user) {
        const r = await postJson("OpenAI-compatible", `${base}/chat/completions`, { Authorization: `Bearer ${v("OPENAI_API_KEY")}` }, {
          model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        });
        const choice = r.choices?.[0];
        if (choice?.finish_reason !== "stop") throw new Error(`OpenAI-compatible: stopped (${choice?.finish_reason ?? "no choice"})`);
        return String(choice.message?.content ?? "").trim();
      },
    };
  }
  return null;
}

// ---- prompt and facts ----

export const SYSTEM_PROMPT = [
  "You explain a daily US stock-market stress reading to a long-term investor in one short paragraph of at most 70 words.",
  "Use only the facts in the JSON you are given. Every number you write must appear in it exactly as written there; prefer words to numbers where you can.",
  "Say what the reading adds up to and what changed today, if anything. Don't forecast, don't give advice, don't add facts from your own knowledge.",
  "Plain text only: no lists, headings or markdown.",
].join(" ");

/** The facts the model may use, rounded exactly as the brief shows them. */
export function briefFacts(d: DayState, todaysEvents: string[]): Record<string, unknown> {
  const band = d.dd_vix_band;
  return {
    date: d.date,
    indicators_total: 6,
    red: d.red_count,
    confirmed_red: d.confirmed_red_count,
    stress_gate: { met: d.wave_authorized, needs_confirmed_red: 3, note: "information only" },
    indicators: INDICATORS.map((i) => ({
      name: i.name,
      reading: i.fmt(d),
      color: d[({ vix: "vix_color", hy_spread: "hy_spread_color", sp_drawdown: "sp_drawdown_color", treasury_10y: "treasury_10y_color", sahm_rule: "sahm_rule_color" } as const)[i.key]],
      confirmed: d.confirmation_state[i.key]?.confirmed ?? false,
    })),
    fed_pivot: d.inputs.fed_pivot_signal,
    sp500: { close: Number(d.inputs.sp500.value.toFixed(2)), all_time_high: Number(d.inputs.sp500_ath.value.toFixed(2)), drawdown_pct: Number(d.sp_drawdown_pct.toFixed(1)) },
    drawdown_risk: band ? riskBandSentence(d) : `not scored: the S&P 500 is already ${d.sp_drawdown_pct.toFixed(1)}% below its high`,
    todays_events: todaysEvents,
  };
}

// ---- the number check ----

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const toNum = (s: string) => Number(s.replace(/,/g, ""));

/** Numbers in the reply that don't appear in the facts (as written, or rounded to fewer decimals). */
export function foreignNumbers(reply: string, facts: unknown): string[] {
  const allowed = new Set<number>();
  for (const m of JSON.stringify(facts).match(NUMBER) ?? []) {
    const n = toNum(m);
    allowed.add(n);
    for (const dp of [0, 1, 2]) allowed.add(Number(n.toFixed(dp)));
  }
  for (const part of JSON.stringify(facts).match(/\d{4}-\d{2}-\d{2}/g) ?? []) {
    for (const p of part.split("-")) allowed.add(Number(p)); // "Nov 20", "2026"
  }
  return (reply.match(NUMBER) ?? []).filter((m) => !allowed.has(toNum(m)));
}

/** The checked paragraph, or why it was dropped (safe to log: no keys, no plan data). */
export async function aiParagraph(
  provider: AiProvider,
  d: DayState,
  todaysEvents: string[],
): Promise<{ text: string } | { dropped: string }> {
  const facts = briefFacts(d, todaysEvents);
  let reply: string;
  try {
    reply = await provider.complete(SYSTEM_PROMPT, JSON.stringify(facts, null, 1));
  } catch (err) {
    return { dropped: err instanceof Error ? err.message : "request failed" };
  }
  if (!reply) return { dropped: "empty reply" };
  if (reply.split(/\s+/).length > 120) return { dropped: "reply too long" };
  const foreign = foreignNumbers(reply, facts);
  if (foreign.length) return { dropped: `reply had numbers not in the data (${foreign.slice(0, 3).join(", ")})` };
  return { text: reply.replace(/\s+/g, " ") };
}

/** Puts the paragraph into the brief, just above the closing "Not investment advice" line. */
export function withAiParagraph(briefBody: string, text: string): string {
  const lines = briefBody.split("\n");
  const last = lines.pop()!;
  return [...lines, `AI summary (checked against the numbers above): ${text}`, last].join("\n");
}
