import { describe, it, expect } from "vitest";
import { replay, sp500Derived } from "./replay.js";
import { parseYahooCloses, type Point } from "./fetch.js";

// Trading dates 2026-01-01 + i days (calendar gaps don't matter to the replay).
const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
const series = (values: number[]): Point[] => values.map((value, i) => ({ date: day(i), value }));
const flat = (n: number, v: number) => series(Array(n).fill(v));

describe("sp500Derived", () => {
  it("tracks the running all-time high and the date it was set", () => {
    const d = sp500Derived(series([100, 110, 105, 120, 90]));
    expect(d.map((x) => x.ath.value)).toEqual([100, 110, 110, 120, 120]);
    expect(d[4].ath.date).toBe(day(3));
  });

  it("counts trading days since a close at or below the trailing 252-day window", () => {
    // Rising for 300 days, then a fall to a new 252-day low on day 300, then a bounce.
    const values = [...Array.from({ length: 300 }, (_, i) => 1000 + i), 900, 950, 960];
    const d = sp500Derived(series(values));
    expect(d[300].daysSinceLow).toBe(0);
    expect(d[302].daysSinceLow).toBe(2);
    // Day 0 is trivially its own low; on a steady rise nothing after it is.
    expect(d[0].daysSinceLow).toBe(0);
    expect(d[299].daysSinceLow).toBe(299);
  });

  it("only looks back 252 closes", () => {
    // An old low 400 days back doesn't stop a newer, higher close being a 252-day low.
    const values = [500, ...Array(399).fill(1000), 999];
    expect(sp500Derived(series(values))[400].daysSinceLow).toBe(0);
  });
});

describe("replay", () => {
  const calm = (n: number) => ({
    vix: flat(n, 15),
    hy_spread_pct: flat(n, 3),
    treasury_10y: flat(n, 4),
    sahm_rule: flat(n, 0.1),
  });

  it("confirms a RED only on its second distinct observation date", () => {
    const n = 10;
    const vix = flat(n, 15).map((p, i) => (i >= 7 ? { ...p, value: 40 } : p));
    const days = replay({ ...calm(n), vix, sp500: flat(n, 100) }, { from: day(0), fedPivot: "NONE" });
    expect(days[7].vix_color).toBe("RED");
    expect(days[7].confirmation_state.vix.confirmed).toBe(false);
    expect(days[8].confirmation_state.vix.confirmed).toBe(true);
    expect(days[8].confirmed_red_count).toBe(1);
  });

  it("uses each series' latest observation on or before the day (monthly Sahm carries forward)", () => {
    const n = 40;
    const sahm = [{ date: day(0), value: 0.6 }, { date: day(31), value: 0.1 }];
    const days = replay({ ...calm(n), sahm_rule: sahm, sp500: flat(n, 100) }, { from: day(0), fedPivot: "NONE" });
    expect(days[30].inputs.sahm_rule).toEqual({ value: 0.6, observation_date: day(0) });
    expect(days[31].inputs.sahm_rule).toEqual({ value: 0.1, observation_date: day(31) });
    // Two Sahm observations a month apart: the second is a new date, so the first RED never confirms twice.
    expect(days[30].confirmation_state.sahm_rule.days_confirmed).toBe(1);
  });

  it("skips days before every series has started", () => {
    const n = 5;
    const days = replay({ ...calm(n), hy_spread_pct: [{ date: day(2), value: 3 }], sp500: flat(n, 100) }, { from: day(0), fedPivot: "NONE" });
    expect(days.map((d) => d.date)).toEqual([day(2), day(3), day(4)]);
  });

  it("opens a drawdown episode at 10% and keeps the deepest trough", () => {
    const sp = series([100, 95, 89, 85, 88, 92]);
    const days = replay({ ...calm(6), sp500: sp }, { from: day(0), fedPivot: "NONE" });
    expect(days[1].sp500_trough).toBeNull();
    expect(days[2].sp500_trough).toBe(89);
    expect(days[3].sp500_trough).toBe(85);
    // Back under 10% but the episode stays open (recovery not confirmed).
    expect(days[5].sp500_trough).toBe(85);
    expect(days[5].dd_vix_band).not.toBeNull();
  });

  it("forgets an old episode at the reset date (default: the current all-time high)", () => {
    const sp = series([100, 85, 101, 102, 90]);
    const days = replay({ ...calm(5), sp500: sp }, { from: day(0), fedPivot: "NONE" });
    // Default reset is day 3 (the 102 high): the 85 trough from day 1 is gone, so day 4's 11.8% fall opens a new episode.
    expect(days[2].sp500_trough).toBe(85);
    expect(days[3].sp500_trough).toBeNull();
    expect(days[4].sp500_trough).toBe(90);
  });

  it("uses the FED_PIVOT setting for every day", () => {
    const days = replay({ ...calm(3), sp500: flat(3, 100) }, { from: day(0), fedPivot: "CUT" });
    expect(days.every((d) => d.fed_pivot_color === "RED")).toBe(true);
    expect(days[0].confirmed_red_count).toBe(1);
  });

  it("uses CUT on days when the Fed's most recent decision was a cut (the data floor)", () => {
    // Days run from 2026-01-01; the Jan 28 meeting cut 25 bp, effective Jan 29.
    // The next meeting (Mar 18) holds, so the floor ends after it.
    const n = 90;
    const fed_target = Array.from({ length: n }, (_, i) => ({ date: day(i), value: day(i) >= "2026-01-29" ? 3.75 : 4.0 }));
    const days = replay({ ...calm(n), sp500: flat(n, 100), fed_target }, { from: day(0), fedPivot: "NONE" });
    const on = (date: string) => days.find((d) => d.date === date)!;
    expect(on("2026-01-28").inputs.fed_pivot_signal).toBe("NONE");
    expect(on("2026-01-29").inputs.fed_pivot_signal).toBe("CUT");
    expect(on("2026-03-18").inputs.fed_pivot_signal).toBe("CUT");
    expect(on("2026-03-19").inputs.fed_pivot_signal).toBe("NONE");
    expect(on("2026-01-29").fed_facts).toMatchObject({ last_change_bp: -25, cut_at_latest_decision: true });
  });
});

describe("parseYahooCloses", () => {
  const body = (ts: number[], closes: (number | null)[], start: number, end: number) => ({
    chart: { result: [{ meta: { currentTradingPeriod: { regular: { start, end } } }, timestamp: ts, indicators: { quote: [{ close: closes }] } }] },
  });
  const t = (iso: string) => Date.parse(iso) / 1000;

  it("drops the in-progress session and null bars", () => {
    const b = body([t("2026-11-19T14:30:00Z"), t("2026-11-20T14:30:00Z"), t("2026-11-21T14:30:00Z")], [10, null, 12], t("2026-11-21T14:30:00Z"), t("2026-11-21T21:00:00Z"));
    expect(parseYahooCloses(b, t("2026-11-21T18:00:00Z"))).toEqual([{ date: "2026-11-19", value: 10 }]);
    // After the close plus the settle buffer, the day's bar counts.
    expect(parseYahooCloses(b, t("2026-11-21T21:31:00Z")).map((p) => p.date)).toEqual(["2026-11-19", "2026-11-21"]);
  });
});
