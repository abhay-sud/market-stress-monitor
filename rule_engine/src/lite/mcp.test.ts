import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDrift, waveAmounts } from "./money.js";
import { parseMyPlan, parseMyPortfolio, type MyPlan } from "./myFiles.js";
import { historyCache, isFresh, lastSettledClose } from "./historyCache.js";
import { replay, type DayState } from "./replay.js";
import { changes, myPlan, pickDay, reading, type DataMeta } from "./mcpTools.js";
import type { LiteHistory, Point } from "./fetch.js";
import { evaluateWaves } from "./plan.js";

const fixture = JSON.parse(readFileSync(new URL("../../../config/fixtures/lite-money.json", import.meta.url), "utf-8"));

describe("copied money calculations (shared fixture with mcp_server)", () => {
  it("wave amounts", () => {
    for (const c of fixture.waves) {
      const a = waveAmounts(c.wave, c.reserve_usd);
      expect({ pct_of_reserve: a.pct_of_reserve, total_usd: a.total_usd, splits_usd: a.splits.map((s) => s.usd) }).toEqual(c.expected);
    }
  });

  it("portfolio drift (the 5/25 rule)", () => {
    for (const c of fixture.drift) {
      const d = accountDrift("main", c.holdings_pct, c.target_pct);
      expect({ entries: d.entries, max_drift_pts: d.max_drift_pts, has_drifted: d.has_drifted }).toEqual(c.expected);
    }
  });
});

const TRIGGERS = {
  fast_panic: {
    WAVE_1: { drawdown_pct_gte: 10, vix_gt: 25 },
    WAVE_2: { drawdown_pct_gte: 20, vix_gt: 30 },
    WAVE_3: { drawdown_pct_gte: 30, vix_gt: 40 },
  },
  slow_bear: { freshness_window_trading_days: 30, WAVE_2: { drawdown_pct_gte: 20 }, WAVE_3: { drawdown_pct_gte: 30 } },
};

describe("the reader's files", () => {
  it("accepts a plan with only triggers, and a full one (unquoted dates included)", () => {
    expect(parseMyPlan({ wave_triggers: TRIGGERS })).toMatchObject({ cash_reserve_usd: null, waves: null, executed: {} });
    const full = parseMyPlan({
      wave_triggers: TRIGGERS,
      cash_reserve_usd: 20000,
      waves: { WAVE_1: { pct_of_reserve: 25, splits: [{ name: "US", pct_of_wave: 60 }, { name: "Intl", pct_of_wave: 40 }] } },
      executed: { WAVE_1: new Date("2026-11-24T00:00:00Z"), WAVE_2: null },
    });
    expect(full.executed).toEqual({ WAVE_1: "2026-11-24" });
    expect(full.waves?.WAVE_1?.pct_of_reserve).toBe(25);
  });

  it("names the bad key and never echoes a value", () => {
    const bad = () =>
      parseMyPlan({
        wave_triggers: TRIGGERS,
        cash_reserve_usd: "98765",
        waves: { WAVE_1: { pct_of_reserve: 25, splits: [{ name: "US", pct_of_wave: 70 }] } },
        executed: { WAVE_4: "2026-01-01" },
      });
    expect(bad).toThrow(/cash_reserve_usd.*add up to 100.*WAVE_4/);
    try {
      bad();
    } catch (err) {
      expect(String(err)).not.toMatch(/98765|70/);
    }
    expect(() => parseMyPlan({ wave_triggers: { fast_panic: {} } })).toThrow(/my_plan.yaml's wave_triggers are invalid/);
    expect(() => parseMyPlan({})).toThrow(/needs a wave_triggers block/);
  });

  it("parses a portfolio and rejects a non-percent", () => {
    expect(parseMyPortfolio({ accounts: { main: { holdings_pct: { a: 60, b: 40 }, target_pct: { a: 50, b: 50 } } } }).accounts[0].name).toBe("main");
    expect(() => parseMyPortfolio({ accounts: { main: { holdings_pct: { a: 160 }, target_pct: {} } } })).toThrow(/accounts.main.holdings_pct.a must be a percent/);
  });
});

describe("history cache", () => {
  // 2026-11-20 is a Friday; New York is UTC-5 in November.
  it("the latest settled close is 4:30pm New York on the last weekday", () => {
    expect(lastSettledClose(new Date("2026-11-20T21:31:00Z")).toISOString()).toBe("2026-11-20T21:30:00.000Z");
    expect(lastSettledClose(new Date("2026-11-20T21:00:00Z")).toISOString()).toBe("2026-11-19T21:30:00.000Z");
    expect(lastSettledClose(new Date("2026-11-22T15:00:00Z")).toISOString()).toBe("2026-11-20T21:30:00.000Z");
    // Summer time: UTC-4.
    expect(lastSettledClose(new Date("2026-07-15T21:00:00Z")).toISOString()).toBe("2026-07-15T20:30:00.000Z");
  });

  it("fresh only after the latest close and within 6 hours", () => {
    const now = new Date("2026-11-20T23:00:00Z");
    expect(isFresh(new Date("2026-11-20T21:45:00Z"), now)).toBe(true);
    expect(isFresh(new Date("2026-11-20T20:00:00Z"), now)).toBe(false); // before the close
    expect(isFresh(new Date("2026-11-22T08:00:00Z"), new Date("2026-11-22T15:00:00Z"))).toBe(false); // 7 hours old
  });

  const history = (): LiteHistory => ({
    sp500: [{ date: "2026-11-20", value: 100 }],
    vix: [], hy_spread_pct: [], treasury_10y: [], sahm_rule: [], fed_target: [], sources: { sp500: "test" },
  });

  it("a second call inside the window makes no request; a failed refresh serves the cache marked stale", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "msm-cache-")), "h.json");
    let calls = 0;
    let fail = false;
    let now = new Date("2026-11-20T22:00:00Z");
    const make = () =>
      historyCache({
        fetch: async () => {
          calls++;
          if (fail) throw new Error("FRED HTTP 503");
          return history();
        },
        now: () => now,
        path,
        fromDate: () => "2024-11-20",
      });
    const c = make();
    expect((await c.get()).stale).toBe(false);
    await c.get();
    expect(calls).toBe(1);
    // A new process reads the file instead of fetching.
    await make().get();
    expect(calls).toBe(1);
    // Next day after the close: refetch, which fails.
    now = new Date("2026-11-23T22:00:00Z");
    fail = true;
    const r = await make().get();
    expect(calls).toBe(2);
    expect(r).toMatchObject({ stale: true, stale_reason: "FRED HTTP 503", fetched_at: "2026-11-20T22:00:00.000Z" });
  });

  it("with no cache, a failed fetch is an error", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "msm-cache-")), "h.json");
    const c = historyCache({ fetch: async () => { throw new Error("offline"); }, now: () => new Date(), path, fromDate: () => "2024-01-01" });
    await expect(c.get()).rejects.toThrow(/no cached copy: offline/);
  });
});

// Trading dates 2026-01-01 + i days.
const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
const series = (values: number[]): Point[] => values.map((value, i) => ({ date: day(i), value }));

/** A 300-day rise to 1000, then a fall to `bottom` over 20 days with VIX at `vix`. */
function crash(bottom: number, vix: number): DayState[] {
  const sp = [...Array.from({ length: 300 }, (_, i) => 700 + i), ...Array.from({ length: 20 }, (_, i) => 999 - ((999 - bottom) * (i + 1)) / 20)];
  const n = sp.length;
  return replay(
    {
      sp500: series(sp),
      vix: series(sp.map((_, i) => (i >= 300 ? vix : 15))),
      hy_spread_pct: series(Array(n).fill(3)),
      treasury_10y: series(Array(n).fill(4)),
      sahm_rule: series(Array(n).fill(0.1)),
    },
    { from: day(0), fedPivot: "NONE" },
  );
}

const META: DataMeta = { fetched_at: "2026-11-20T22:00:00.000Z", stale: false, sources: { sp500: "test" } };
const plan = (extra: Partial<MyPlan> = {}): MyPlan => ({
  wave_triggers: TRIGGERS,
  cash_reserve_usd: 20000,
  waves: {
    WAVE_1: { pct_of_reserve: 20, splits: [{ name: "US total market", pct_of_wave: 100 }] },
    WAVE_2: { pct_of_reserve: 30, splits: [{ name: "US total market", pct_of_wave: 50 }, { name: "International", pct_of_wave: 50 }] },
    WAVE_3: { pct_of_reserve: 50, splits: [{ name: "US total market", pct_of_wave: 100 }] },
  },
  executed: {},
  ...extra,
});

describe("get_my_plan", () => {
  it("a fast fall to Wave 2 returns Waves 1 and 2, cumulative, in dollars", () => {
    const days = crash(780, 33); // 22% below the high, VIX 33
    const p = myPlan(days, plan(), META);
    expect(p.current_level).toBe("Wave 2 (fast panic)");
    expect(p.waves.map((w) => w.armed)).toEqual([true, true, false]);
    expect(p.waves[2].fast_panic).toMatchObject({ met_today: false, drawdown_points_to_go: 8.1, vix_points_to_go: 7 });
    expect(p.deploy_now).toMatchObject({ total_usd: 10000, cash_reserve_usd: 20000 });
    expect((p.deploy_now as any).waves.map((w: any) => [w.wave, w.total_usd])).toEqual([["Wave 1", 4000], ["Wave 2", 6000]]);
    expect(p.deploy_now).toHaveProperty("several_pending");
  });

  it("skips executed waves; without a reserve it shows percentages only", () => {
    const days = crash(780, 33);
    const done = myPlan(days, plan({ executed: { WAVE_1: "2026-10-20" } }), META);
    expect((done.deploy_now as any).waves.map((w: any) => w.wave)).toEqual(["Wave 2"]);
    expect(done.waves[0].executed_on).toBe("2026-10-20");
    const pct = myPlan(days, plan({ cash_reserve_usd: null }), META);
    expect(pct.deploy_now).toMatchObject({ total_pct_of_reserve: 50 });
    expect(JSON.stringify(pct)).not.toMatch(/usd"\s*:\s*\d/);
  });

  it("nothing armed: nothing to deploy, and the slow-bear streak is reported", () => {
    const p = myPlan(crash(950, 18), plan(), META);
    expect(p.current_level).toBe("No wave armed");
    expect(p.deploy_now).toMatchObject({ waves: [] });
    expect(p.waves[1].slow_bear).toMatchObject({ met_today: false, dates_met_in_a_row: 0, dates_needed: 2 });
  });
});

describe("get_reading and get_changes", () => {
  it("reads the latest day or a past one, and refuses dates before the replay", () => {
    const days = crash(780, 33);
    const r = reading(days[days.length - 1], META, { fedPivotSet: false });
    expect(r.sp500.drawdown_pct).toBeCloseTo(22, 0);
    expect(r.indicators.find((i) => i.indicator === "VIX")?.color).toBe("AMBER");
    expect(r.fed_pivot.set_by).toBe("default (FED_PIVOT not set)");
    expect(r.drawdown_risk_band.band).toBeNull();
    expect((pickDay(days, day(150)) as DayState).date).toBe(day(150));
    expect(pickDay(days, "2025-01-01")).toHaveProperty("error");
  });

  it("lists the drawdown lines crossed and the reader's own wave alerts", () => {
    const days = crash(780, 33);
    const c = changes(days, 20, plan(), META);
    const lines = c.events.filter((e) => e.kind === "drawdown_line").map((e) => e.detail);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/past the 10% line/);
    expect(lines[1]).toMatch(/past the 20% line/);
    expect(c.events.filter((e) => e.kind === "your_wave").map((e) => e.title)).toEqual(["Wave 1 trigger hit", "Wave 2 trigger hit"]);
    // No amounts in alert text.
    expect(JSON.stringify(c)).not.toMatch(/20000|4000|6000/);
  });
});

describe("the example files, over the real 2020 and 2022 bear markets", () => {
  const load = (name: string) => yamlLoad(readFileSync(new URL(`../../../local_state/${name}`, import.meta.url), "utf-8")) as Record<string, unknown>;
  const examplePlan = parseMyPlan(load("my_plan.example.yaml"));

  it("both example files are valid", () => {
    expect(examplePlan.cash_reserve_usd).toBe(20000);
    expect(parseMyPortfolio(load("my_portfolio.example.yaml")).accounts.map((a) => a.name)).toEqual(["retirement", "taxable"]);
  });

  /** Replays a real S&P/VIX fixture with calm values for the other four inputs (waves read only drawdown, VIX and the one-year low). */
  function realDays(file: string): DayState[] {
    const fx = JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf-8")) as { sp500: Point[]; vix: Point[] };
    const calm = (v: number) => fx.sp500.map((p) => ({ date: p.date, value: v }));
    return replay(
      { sp500: fx.sp500, vix: fx.vix, hy_spread_pct: calm(3), treasury_10y: calm(2), sahm_rule: calm(0) },
      { from: fx.vix[0].date, fedPivot: "NONE" },
    );
  }

  for (const [file, expected] of [
    // 2020: the fall stopped at 33.9%, short of Wave 3. 2022: VIX never passed the Wave 2 level, so the slow-bear pathway armed it at the October low.
    ["sp500_vix_2020.json", [["Wave 1", "fast panic", "2020-03-09"], ["Wave 2", "fast panic", "2020-03-12"]]],
    ["sp500_vix_2022.json", [["Wave 1", "fast panic", "2022-05-09"], ["Wave 2", "slow bear", "2022-10-12"]]],
  ] as const) {
    it(`${file}: get_my_plan arms the same waves on the same dates as evaluateWaves`, () => {
      const days = realDays(file);
      const truth = evaluateWaves(
        days.map((d) => ({ date: d.date, drawdown_pct: d.sp_drawdown_pct, vix: d.inputs.vix.value, days_since_252d_low: d.sp500_days_since_252d_low })),
        examplePlan.wave_triggers,
      );
      const firstArmed: [string, string, string][] = [];
      let prevLevel = "No wave armed";
      for (let i = 0; i < days.length; i++) {
        const p = myPlan(days.slice(0, i + 1), examplePlan, META);
        const want = truth[i].wave === "NONE" ? "No wave armed" : `${truth[i].wave.replace("WAVE_", "Wave ")} (${truth[i].reason === "SLOW_BEAR" ? "slow bear" : "fast panic"})`;
        expect(p.current_level, days[i].date).toBe(want);
        if (p.current_level !== prevLevel && p.current_level !== "No wave armed") {
          const m = /^(Wave \d) \((.+)\)$/.exec(p.current_level)!;
          if (!firstArmed.some(([w]) => w === m[1])) firstArmed.push([m[1], m[2], days[i].date]);
        }
        prevLevel = p.current_level;
      }
      expect(firstArmed).toEqual(expected);
    });
  }
});
