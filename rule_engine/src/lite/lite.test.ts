import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { replay, type DayState } from "./replay.js";
import { detectEvents, formatBrief, riskBandSentence } from "./events.js";
import { parsePlan, evaluateWaves, waveAlertDays, waveAlertMessage, QUIET_DATES_TO_REARM, type WaveTriggers } from "./plan.js";
import { decideRun, briefMode, EMPTY_STATE } from "./decide.js";
import { channelsFromEnv, sendAll } from "./notify.js";
import type { Point } from "./fetch.js";

// ---- helpers: synthetic trading days ----
const day = (i: number) => new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10);
const series = (values: number[]): Point[] => values.map((value, i) => ({ date: day(i), value }));
const flat = (n: number, v: number) => series(Array(n).fill(v));
function days(sp: number[], vix: number[] | number = 15): DayState[] {
  const n = sp.length;
  return replay(
    {
      sp500: series(sp),
      vix: typeof vix === "number" ? flat(n, vix) : series(vix),
      hy_spread_pct: flat(n, 3),
      treasury_10y: flat(n, 4),
      sahm_rule: flat(n, 0.1),
    },
    { from: day(0), fedPivot: "NONE" },
  );
}

const examplePlanText = readFileSync(new URL("../../../local_state/policy.example.yaml", import.meta.url), "utf-8");

// ---- plan ----
describe("parsePlan", () => {
  it("accepts the example policy file (wave_triggers block inside a full policy)", () => {
    const t = parsePlan(examplePlanText);
    expect(t.fast_panic.WAVE_1.drawdown_pct_gte).toBe(15);
    expect(t.slow_bear.freshness_window_trading_days).toBe(30);
  });

  it("accepts the bare block too", () => {
    const t = parsePlan("fast_panic:\n  WAVE_1: {drawdown_pct_gte: 1, vix_gt: 2}\n  WAVE_2: {drawdown_pct_gte: 3, vix_gt: 4}\n  WAVE_3: {drawdown_pct_gte: 5, vix_gt: 6}\nslow_bear:\n  freshness_window_trading_days: 7\n  WAVE_2: {drawdown_pct_gte: 8}\n  WAVE_3: {drawdown_pct_gte: 9}\n");
    expect(t.fast_panic.WAVE_3.vix_gt).toBe(6);
  });

  it("names the bad key and never echoes a value", () => {
    const secretish = "fast_panic:\n  WAVE_1: {drawdown_pct_gte: 13.37, vix_gt: 'abc-secret-123'}\n";
    let message = "";
    try { parsePlan(secretish); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/fast_panic\.WAVE_1/);
    expect(message).toMatch(/slow_bear/);
    expect(message).not.toMatch(/13\.37|abc-secret-123/);
    expect(() => parsePlan("::: not yaml :::\n  - [")).toThrow(/not valid YAML/);
  });
});

describe("wave alerts on the real 2020 crash (example plan)", () => {
  const fx = JSON.parse(readFileSync(new URL("../fixtures/sp500_vix_2020.json", import.meta.url), "utf-8")) as { sp500: Point[]; vix: Point[] };
  const flatFrom = (v: number): Point[] => [{ date: "2017-01-01", value: v }];
  const d = replay(
    { sp500: fx.sp500, vix: fx.vix, hy_spread_pct: flatFrom(3), treasury_10y: flatFrom(2), sahm_rule: flatFrom(0) },
    { from: "2020-01-02", fedPivot: "NONE" },
  );
  const plan = parsePlan(examplePlanText);
  const waves = evaluateWaves(d.map((x) => ({ date: x.date, drawdown_pct: x.sp_drawdown_pct, vix: x.inputs.vix.value, days_since_252d_low: x.sp500_days_since_252d_low })), plan);
  const fired = waveAlertDays(waves);

  it("fires Wave 1 then Wave 2, once each and in order; never Wave 3 (the fall stopped at 33.9%)", () => {
    expect(fired.map((w) => w.wave)).toEqual(["WAVE_1", "WAVE_2"]);
    expect(fired[0].date < fired[1].date).toBe(true);
    expect(fired[0].date >= "2020-03-01" && fired[1].date <= "2020-03-31").toBe(true);
  });

  it("wave alert text names the wave and the gate, never a trigger level", () => {
    const m = waveAlertMessage(fired[1], false, 1);
    expect(m.title).toBe("Wave 2 trigger hit");
    expect(`${m.title} ${m.body}`).not.toMatch(/\b(15|25|35|30|40)\b/);
  });
});

describe("waveAlertDays re-arm rule (same as mcp_server/src/lib/waveAlert.ts)", () => {
  const w = (wave: "NONE" | "WAVE_1" | "WAVE_2", i: number) => ({ date: day(i), wave, reason: wave === "NONE" ? null : ("FAST_PANIC" as const) });
  it("stays quiet on a dip and return, re-arms after enough quiet dates", () => {
    const seq = [w("WAVE_1", 0), w("NONE", 1), w("WAVE_1", 2), w("WAVE_2", 3)];
    expect(waveAlertDays(seq).map((x) => x.wave)).toEqual(["WAVE_1", "WAVE_2"]);
    const quiet = Array.from({ length: QUIET_DATES_TO_REARM }, (_, k) => w("NONE", 1 + k));
    expect(waveAlertDays([w("WAVE_1", 0), ...quiet, w("WAVE_1", 50)]).length).toBe(2);
    expect(waveAlertDays([w("WAVE_1", 0), ...quiet.slice(1), w("WAVE_1", 50)]).length).toBe(1);
  });
});

// ---- events ----
describe("detectEvents", () => {
  it("alerts when an indicator becomes confirmed RED, and when it leaves RED", () => {
    const e = detectEvents(days(Array(8).fill(100), [15, 15, 40, 41, 42, 15, 15, 15]));
    const vix = e.filter((x) => x.kind === "confirmed_red" || x.kind === "left_red");
    expect(vix.map((x) => [x.kind, x.date])).toEqual([["confirmed_red", day(3)], ["left_red", day(5)]]);
  });

  it("alerts once per drawdown line, re-armed only after a real recovery", () => {
    // 10% line: cross, hover around it, recover 3 points, cross again.
    const sp = [100, 95, 89.5, 90.5, 89.8, 93, 89, 79];
    const e = detectEvents(days(sp)).filter((x) => x.kind === "drawdown_line");
    expect(e.map((x) => x.date)).toEqual([day(2), day(6), day(7)]);
    expect(e[2].body).toMatch(/past the 20% line/);
  });

  it("doesn't alert for a line already crossed when the history starts", () => {
    expect(detectEvents(days([100, 85, 84, 83].map((v, i) => (i === 0 ? 100 : v)).slice(1))).filter((x) => x.kind === "drawdown_line")).toEqual([]);
  });

  it("alerts when the drawdown risk band changes", () => {
    // drawdown 0 + VIX/5: 15 -> 3 (Low), 45 -> 9 (Elevated).
    const e = detectEvents(days([100, 100, 100], [15, 15, 45])).filter((x) => x.kind === "risk_band");
    expect(e).toHaveLength(1);
    expect(e[0].title).toBe("Drawdown risk: Low → Elevated");
  });

  it("doesn't alert when the risk band falls (the brief shows it)", () => {
    expect(detectEvents(days([100, 100, 100], [45, 45, 15])).filter((x) => x.kind === "risk_band")).toEqual([]);
  });

  it("alerts once when a series goes stale", () => {
    const n = 12;
    const d = replay(
      { sp500: flat(n, 100), vix: flat(n, 15), hy_spread_pct: series([3, 3]), treasury_10y: flat(n, 4), sahm_rule: flat(n, 0.1) },
      { from: day(0), fedPivot: "NONE" },
    );
    const stale = detectEvents(d).filter((x) => x.kind === "stale_data");
    expect(stale).toHaveLength(1);
    expect(stale[0].title).toBe("High-yield spread data is stale");
  });
});

describe("Treasury 10-year fill", () => {
  it("parses the 10 Yr column and fills only dates after FRED's latest", async () => {
    const { parseTreasury10y, fillAfter } = await import("./fetch.js");
    const csv = ['Date,"1 Mo","10 Yr","30 Yr"', "11/20/2026,4.1,4.92,5.1", "11/19/2026,4.1,5.04,5.2", "11/18/2026,4.1,,5.2", ""].join("\r\n");
    expect(parseTreasury10y(csv)).toEqual([{ date: "2026-11-20", value: 4.92 }, { date: "2026-11-19", value: 5.04 }]);
    expect(parseTreasury10y("")).toEqual([]);
    expect(() => parseTreasury10y(["Date,1 Mo", "11/20/2026,4.1"].join("\n"))).toThrow(/10 Yr/);
    const fred = [{ date: "2026-11-18", value: 5.07 }, { date: "2026-11-19", value: 5.04 }];
    expect(fillAfter(fred, [{ date: "2026-11-19", value: 9.99 }, { date: "2026-11-20", value: 4.92 }])).toEqual([...fred, { date: "2026-11-20", value: 4.92 }]);
  });
});

describe("formatBrief", () => {
  it("shows the date of a reading older than the S&P close", () => {
    const n = 3;
    const d = replay(
      { sp500: flat(n, 100), vix: flat(n, 15), hy_spread_pct: series([4, 4]), treasury_10y: flat(n, 4.5), sahm_rule: flat(n, 0.1) },
      { from: day(0), fedPivot: "NONE" },
    );
    const { body } = formatBrief(d[2], { fedPivotSet: true });
    expect(body).toContain("High-yield spread 400 bp (Jan 6)"); // last reading a day before the S&P close
    expect(body).toContain("10-year Treasury 4.50%"); // same day: no date
    expect(body).not.toContain("10-year Treasury 4.50% (");
  });

  it("lists RED and AMBER readings, the gate, the risk band and what's closest to RED", () => {
    const d = days([100, 100, 100], [36, 36, 36]);
    const { title, body } = formatBrief(d[2], { fedPivotSet: false });
    expect(title).toMatch(/^Market stress · \w{3} \w{3} \d+$/);
    expect(body).toContain("1 of 6 RED: VIX 36.00 (confirmed)");
    expect(body).toContain("Stress gate: not met (1 of 6 confirmed RED; the gate needs 3)");
    expect(body).toContain("Drawdown risk: Low."); // 0% drawdown + 36/5 = 7.2, under the 8.5 cutoff
    expect(body).toContain("Fed pivot: not tracked");
    expect(body).toContain("Not investment advice");
  });

  it("says the band isn't scored once the drawdown is 10%+", () => {
    const d = days([100, 88]);
    expect(riskBandSentence(d[1])).toMatch(/not scored, because the S&P 500 is already 12\.0% below its high/);
  });
});

// ---- decide ----
describe("decideRun", () => {
  const d = days([100, 100, 89, 88], [15, 15, 15, 15]); // 10% line crossed on day 2
  const base = { brief: "daily" as const, runDate: day(3), plan: null, fedPivotSet: true };

  it("first run (no state): only the latest date's events, plus the brief", () => {
    const r = decideRun(d, EMPTY_STATE, base);
    expect(r.messages.filter((m) => m.priority === "high")).toEqual([]); // the crossing was on day 2, not the latest day
    expect(r.messages.map((m) => m.title)[0]).toMatch(/^Market stress/);
    expect(r.next.last_date).toBe(day(3));
  });

  it("later run: every event after the last processed date, and one brief per new day", () => {
    const r = decideRun(d, { ...EMPTY_STATE, last_date: day(1), last_brief_date: day(1) }, base);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].title).toBe("S&P 500 now 11.0% below its high");
    expect(r.messages[1].title).toBe("Market stress · Thu Jan 8");
    const again = decideRun(d, r.next, base);
    expect(again.messages).toEqual([]);
  });

  it("dates each event, and bundles more than three into one digest", () => {
    const few = decideRun(d, { ...EMPTY_STATE, last_date: day(1), last_brief_date: day(3) }, base);
    expect(few.messages[0].body).toMatch(/^Wed Jan 7: /);
    // VIX RED then back, the 10% line, and a band rise: more than three events after day 0.
    const busy = days([100, 100, 89, 88, 87, 87], [15, 45, 45, 36, 36, 15]);
    const r = decideRun(busy, { ...EMPTY_STATE, last_date: day(0), last_brief_date: day(5) }, { ...base, runDate: day(5) });
    const high = r.messages.filter((m) => m.priority === "high");
    expect(high).toHaveLength(1);
    expect(high[0].title).toMatch(/^\d+ market stress alerts since /);
  });

  it("weekly brief only on Fridays; off means events only", () => {
    expect(briefMode(undefined)).toBe("daily");
    expect(() => briefMode("hourly")).toThrow();
    const friday = "2026-01-09";
    const monday = "2026-01-12";
    expect(decideRun(d, EMPTY_STATE, { ...base, brief: "weekly", runDate: monday }).messages).toEqual([]);
    expect(decideRun(d, EMPTY_STATE, { ...base, brief: "weekly", runDate: friday }).messages).toHaveLength(1);
    expect(decideRun(d, EMPTY_STATE, { ...base, brief: "off" }).messages).toEqual([]);
  });

  it("alerts once when no new S&P close has arrived for days", () => {
    const late = { ...base, runDate: "2026-01-20" };
    const r = decideRun(d, { ...EMPTY_STATE, last_date: day(3), last_brief_date: day(3) }, late);
    expect(r.messages.map((m) => m.title)).toEqual(["No new S&P 500 close"]);
    expect(decideRun(d, r.next, late).messages).toEqual([]);
  });

  it("plan alerts are marked personal and nothing in the log or message text carries plan values", () => {
    const plan: WaveTriggers = parsePlan(
      "fast_panic:\n  WAVE_1: {drawdown_pct_gte: 10.77, vix_gt: 12.34}\n  WAVE_2: {drawdown_pct_gte: 60.11, vix_gt: 70.22}\n  WAVE_3: {drawdown_pct_gte: 80.33, vix_gt: 90.44}\nslow_bear:\n  freshness_window_trading_days: 29\n  WAVE_2: {drawdown_pct_gte: 61.55}\n  WAVE_3: {drawdown_pct_gte: 81.66}\n",
    );
    const r = decideRun(d, { ...EMPTY_STATE, last_date: day(1) }, { ...base, plan });
    const personal = r.messages.filter((m) => m.personal);
    expect(personal.map((m) => m.title)).toEqual(["Wave 1 trigger hit"]);
    const everything = [...r.log, ...r.messages.map((m) => `${m.title} ${m.body}`)].join("\n");
    expect(everything).not.toMatch(/10\.77|12\.34|60\.11|61\.55|\b29\b/);
    expect(r.log.join(" ")).not.toMatch(/WAVE|Wave \d/);
  });
});

// ---- notify ----
describe("notifications", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("enables only the channels whose secrets are set", () => {
    expect(channelsFromEnv({}).map((c) => c.name)).toEqual([]);
    expect(channelsFromEnv({ NTFY_TOPIC: "t", ALERT_EMAIL: "a@example.com", DISCORD_WEBHOOK_URL: "https://x", TELEGRAM_BOT_TOKEN: "k" }).map((c) => c.name)).toEqual(["ntfy (+email)", "Discord"]);
  });

  it("sends ntfy as JSON with the title intact, and errors never contain the URL or token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("nope", { status: url.includes("telegram") ? 401 : 200 });
    });
    const ch = channelsFromEnv({ NTFY_TOPIC: "my-topic", TELEGRAM_BOT_TOKEN: "SECRET-TOKEN", TELEGRAM_CHAT_ID: "42" });
    const failures = await sendAll(ch, { title: "Drawdown risk: Low → Elevated · Fri", body: "b", priority: "high" });
    expect(calls[0].url).toBe("https://ntfy.sh/");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ topic: "my-topic", title: "Drawdown risk: Low → Elevated · Fri", message: "b", priority: 4, tags: ["rotating_light"] });
    expect(failures).toEqual(["Telegram: Telegram: HTTP 401"]);
    expect(failures.join(" ")).not.toMatch(/SECRET-TOKEN|api\.telegram/);
  });

  it("throws only when every channel fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    await expect(sendAll(channelsFromEnv({ NTFY_TOPIC: "t" }), { title: "t", body: "b", priority: "default" })).rejects.toThrow(/every channel failed/);
  });
});
