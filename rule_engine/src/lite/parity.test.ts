// Raw-data parity: replaying the histories the lite fetcher downloads (what
// the lightweight MCP server and the alerts copy do) reproduces what the live
// rule engine stored in crash_checks.
//
// A live run classifies whatever was published at run time, and a replay
// sees each series' settled value for the day. They differ when the live run
// saw other data: before the 2026-11-16 Treasury fill the 10-year was a day
// old; when FRED's S&P lagged, a newer VIX was paired with an older close;
// before 2026-11-09 VIX was an intraday snapshot; monthly series (Sahm) are
// published weeks later. So every difference must trace back to different
// input data, and most days must match outright, so the test can't pass by
// explaining everything away.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { replay, type DayState } from "./replay.js";
import { reading } from "./mcpTools.js";
import { loadLiteHistoryFixture } from "./testFixtures.js";

type Stored = Record<string, any>;
const history = loadLiteHistoryFixture();
const rows = (JSON.parse(readFileSync(new URL("../fixtures/crash_checks_since_2026-09-19.json", import.meta.url), "utf-8")) as { rows: Stored[] }).rows;

const days = replay(history, { from: "2025-09-01", fedPivot: "NONE" });
const byDate = new Map(days.map((d) => [d.date, d]));

// The last stored row for each S&P close it classified (rows copied forward have no inputs).
const stored = new Map<string, Stored>();
for (const r of rows) if (r.inputs?.sp500?.observation_date) stored.set(r.inputs.sp500.observation_date, r);
const dates = [...stored.keys()].filter((date) => byDate.has(date));

// Panel indicator -> its input in the stored row and in the replay, and its colour column.
const SERIES: Record<string, [string, keyof DayState["inputs"], keyof DayState]> = {
  vix: ["vix", "vix", "vix_color"],
  hy_spread: ["hySpread", "hy_spread_pct", "hy_spread_color"],
  sp_drawdown: ["sp500", "sp500", "sp_drawdown_color"],
  treasury_10y: ["treasury10y", "treasury_10y", "treasury_10y_color"],
  sahm_rule: ["sahmRule", "sahm_rule", "sahm_rule_color"],
};

/** True when the live run classified different data for this indicator than the replay did. */
function inputDiffers(r: Stored, d: DayState, ind: string): boolean {
  const [s, k] = SERIES[ind];
  const a = r.inputs[s];
  const b = d.inputs[k] as { value: number; observation_date: string };
  return a.observation_date !== b.observation_date || Math.abs(a.value - b.value) >= 0.005;
}

/** Indicators whose colour or confirmation differ between the stored row and the replayed day. */
function differing(r: Stored, d: DayState): string[] {
  return Object.keys(SERIES).filter((ind) => {
    const a = r.confirmation_state[ind];
    const b = d.confirmation_state[ind];
    return r[SERIES[ind][2] as string] !== d[SERIES[ind][2]] || a.color !== b.color || a.confirmed !== b.confirmed;
  });
}

describe("replaying raw data reproduces the stored crash_checks rows", () => {
  it("every difference is explained by the live run having seen different data", () => {
    const unexplained: string[] = [];
    let exact = 0;
    dates.forEach((date, i) => {
      const r = stored.get(date)!;
      const d = byDate.get(date)!;
      const diff = differing(r, d);
      // A confirmation streak carries a difference forward: the input may differ on this day or the three before it.
      const recent = dates.slice(Math.max(0, i - 3), i + 1);
      for (const ind of diff) {
        if (!recent.some((x) => inputDiffers(stored.get(x)!, byDate.get(x)!, ind))) unexplained.push(`${date} ${ind}`);
      }
      const drawdownSame = Math.abs(d.sp_drawdown_pct - r.sp_drawdown_pct) < 0.01;
      if (!drawdownSame && !inputDiffers(r, d, "sp_drawdown")) unexplained.push(`${date} drawdown`);
      const bandSame = r.dd_vix_band == null || d.dd_vix_band === r.dd_vix_band;
      if (!bandSame && !inputDiffers(r, d, "vix") && !inputDiffers(r, d, "sp_drawdown")) unexplained.push(`${date} drawdown risk band`);
      // The Fed pivot isn't in raw data (it was set by judgment): compare the numeric five.
      const confirmedSame = d.confirmed_red_count === r.confirmed_red_count - (r.fed_pivot_color === "RED" ? 1 : 0);
      if (diff.length === 0 && !confirmedSame) unexplained.push(`${date} confirmed RED count`);
      if (diff.length === 0 && confirmedSame && drawdownSame && bandSame) exact++;
    });
    expect(unexplained).toEqual([]);
    expect(dates.length).toBeGreaterThan(40);
    // 33 of 42 days matched outright when this fixture was made.
    expect(exact).toBeGreaterThanOrEqual(30);
  });

  it("get_reading on the last stored day gives the live site's Friday 20 November reading", () => {
    const meta = { fetched_at: "2026-11-22T00:00:00.000Z", stale: false, sources: {} };
    const r = reading(byDate.get("2026-11-20")!, meta, { fedPivotSet: false });
    expect(r.summary.lines.slice(0, 2)).toEqual([
      "1 of 6 RED: VIX 35.89 (not yet confirmed)",
      "3 AMBER: High-yield spread 352 bp (Nov 19) · S&P 500 drawdown 11.6% · 10-year Treasury 4.92%",
    ]);
    expect(r.sp500).toMatchObject({ close: 6910.39, all_time_high: 7818.93, drawdown_pct: 11.62, episode_trough: 6910.39 });
    // The fixture starts in 2024-09, after the last one-year low, so the count stops at its start (live: 1031).
    expect(r.sp500.trading_days_since_252d_low).toBeGreaterThan(252);
    expect(r.drawdown_risk_band.band).toBeNull();
  });
});
