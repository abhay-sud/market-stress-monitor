import { describe, it, expect, vi, afterEach } from "vitest";
import { replay, type DayState } from "./replay.js";
import { aiProviderFromEnv, aiParagraph, briefFacts, foreignNumbers, withAiParagraph, type AiProvider } from "./ai.js";
import { formatBrief } from "./events.js";
import type { Point } from "./fetch.js";

const day = (i: number) => new Date(Date.UTC(2026, 10, 16 + i)).toISOString().slice(0, 10);
const series = (values: number[]): Point[] => values.map((value, i) => ({ date: day(i), value }));
const flat = (n: number, v: number) => series(Array(n).fill(v));
// S&P 11.6% below its high, VIX 35.89 (RED, first day), 10-year 4.92% (AMBER).
const d: DayState = replay(
  { sp500: series([7818.93, 7400, 7100, 6990, 6910.39]), vix: series([16, 20, 24, 30, 35.89]), hy_spread_pct: flat(5, 3.52), treasury_10y: flat(5, 4.92), sahm_rule: flat(5, 0) },
  { from: day(0), fedPivot: "NONE" },
).at(-1)!;

const fake = (reply: string | Error): AiProvider => ({
  name: "anthropic",
  model: "test",
  complete: async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  },
});

describe("the number check", () => {
  const facts = briefFacts(d, ["S&P 500 now 11.6% below its high"]);

  it("accepts numbers from the facts, as written or rounded, and date parts", () => {
    expect(foreignNumbers("VIX at 35.89 (about 36) put 1 of 6 indicators in the red on Nov 20; the S&P is 11.6% off its high of 7,818.93.", facts)).toEqual([]);
  });

  it("flags any number the facts don't contain", () => {
    expect(foreignNumbers("A 30% chance of a recession within 2 years.", facts)).toEqual(["30", "2"]);
  });

  it("drops a reply with an invented number, and keeps the brief", async () => {
    const r = await aiParagraph(fake("VIX is 35.89, its highest since 2020."), d, []);
    expect(r).toEqual({ dropped: expect.stringMatching(/numbers not in the data \(2020\)/) });
  });

  it("drops on a provider error, an empty reply or a runaway reply", async () => {
    expect(await aiParagraph(fake(new Error("Anthropic: HTTP 529")), d, [])).toEqual({ dropped: "Anthropic: HTTP 529" });
    expect(await aiParagraph(fake(""), d, [])).toEqual({ dropped: "empty reply" });
    expect(await aiParagraph(fake("word ".repeat(200)), d, [])).toEqual({ dropped: "reply too long" });
  });

  it("puts the paragraph above the disclaimer line", async () => {
    const r = await aiParagraph(fake("Stress is rising:\nVIX is RED for the first time, and the S&P 500 is 11.6% below its high."), d, []);
    expect(r).toEqual({ text: "Stress is rising: VIX is RED for the first time, and the S&P 500 is 11.6% below its high." });
    const body = withAiParagraph(formatBrief(d, { fedPivotSet: true }).body, (r as { text: string }).text);
    const lines = body.split("\n");
    expect(lines.at(-2)).toMatch(/^AI summary \(checked against the numbers above\): Stress is rising/);
    expect(lines.at(-1)).toMatch(/^Not investment advice/);
  });
});

describe("providers", () => {
  afterEach(() => vi.unstubAllGlobals());
  const capture = (response: unknown, status = 200) => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(response), { status });
    });
    return calls;
  };

  it("is off with no key, and picks Anthropic first", () => {
    expect(aiProviderFromEnv({})).toBeNull();
    expect(aiProviderFromEnv({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", AI_MODEL: "x" })?.name).toBe("anthropic");
  });

  it("Anthropic: default model with server-side fallback, effort low, text blocks joined", async () => {
    const calls = capture({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Calm " }, { type: "text", text: "day." }] });
    const p = aiProviderFromEnv({ ANTHROPIC_API_KEY: "sk-test" })!;
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(await p.complete("sys", "user")).toBe("Calm day.");
    const h = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(h["x-api-key"]).toBe("sk-test");
    expect(h["anthropic-version"]).toBe("2026-10-21");
    expect(h["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ model: "claude-sonnet-5-5", system: "sys", output_config: { effort: "low" }, fallbacks: "default" });
  });

  it("Anthropic: a chosen model gets no fallback setting; a refusal is an error", async () => {
    const calls = capture({ stop_reason: "refusal", content: [] });
    const p = aiProviderFromEnv({ ANTHROPIC_API_KEY: "k", AI_MODEL: "claude-haiku-5-5" })!;
    await expect(p.complete("s", "u")).rejects.toThrow("Anthropic: stopped (refusal)");
    expect((calls[0].init.headers as Record<string, string>)["anthropic-beta"]).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body)).fallbacks).toBeUndefined();
  });

  it("Gemini: needs AI_MODEL; reads the first candidate", async () => {
    expect(() => aiProviderFromEnv({ GEMINI_API_KEY: "g" })).toThrow(/AI_MODEL/);
    const calls = capture({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Quiet." }] } }] });
    const p = aiProviderFromEnv({ GEMINI_API_KEY: "g-key", AI_MODEL: "some-model" })!;
    expect(await p.complete("s", "u")).toBe("Quiet.");
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/some-model:generateContent");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");
  });

  it("OpenAI-compatible: custom base URL, bearer key; errors never include the key or URL", async () => {
    const calls = capture({ choices: [{ finish_reason: "stop", message: { content: "Fine." } }] });
    const p = aiProviderFromEnv({ OPENAI_API_KEY: "SECRET-KEY", OPENAI_BASE_URL: "https://example.test/v1/", AI_MODEL: "m" })!;
    expect(await p.complete("s", "u")).toBe("Fine.");
    expect(calls[0].url).toBe("https://example.test/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer SECRET-KEY");
    capture({ error: "nope" }, 401);
    const err = await p.complete("s", "u").catch((e: Error) => e.message);
    expect(err).toBe("OpenAI-compatible: HTTP 401");
  });
});
