import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stepPanel, type PanelCarry, type FedPivotSignal, type Reading } from "./panelStep.js";

// Parity with the live engine: every crash_checks row the daily run stored
// since 2026-09-19 (after the F07/F08 confirmation and trough fixes) is
// re-derived with stepPanel from the exact readings that run classified
// (raw_source_data) and the previous stored row as its prior, the same
// inputs classify() had. Rows copied by other writers have no inputs; they
// are only used as the next row's prior, exactly as in production.

interface FixtureRow {
  run_at: string;
  inputs: Record<"vix" | "hySpread" | "sp500" | "sp500Ath" | "treasury10y" | "sahmRule", Reading> | null;
  fed_pivot_signal: FedPivotSignal;
  [key: string]: unknown;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/crash_checks_since_2026-09-19.json", import.meta.url), "utf-8"),
) as { rows: FixtureRow[] };

const carryOf = (r: FixtureRow): PanelCarry => ({
  confirmation_state: r.confirmation_state as PanelCarry["confirmation_state"],
  sp500_trough: r.sp500_trough as number | null,
  sp500_trough_date: r.sp500_trough_date as string | null,
  recovery_confirmed: r.recovery_confirmed as boolean,
  recovery_confirmed_date: r.recovery_confirmed_date as string | null,
});

const COMPARED = [
  "vix_color",
  "hy_spread_color",
  "sp_drawdown_color",
  "treasury_10y_color",
  "sahm_rule_color",
  "fed_pivot_color",
  "red_count",
  "confirmed_red_count",
  "wave_authorized",
  "confirmation_state",
  "sp500_trough_date",
  "recovery_confirmed",
  "recovery_confirmed_date",
] as const;

// Columns added after 2026-09-19: compared from the first row that has them.
const COMPARED_WHEN_STORED = ["distance_to_red", "dd_vix_score", "dd_vix_band"] as const;
const DD_VIX_LIVE_FROM = "2026-11-17T12:00:00Z"; // dd_vix_* columns, migration 20261117000000

describe("stepPanel reproduces the live engine's stored rows", () => {
  const rows = fixture.rows;
  const cases = rows
    .map((row, i) => ({ row, prior: i > 0 ? rows[i - 1] : null }))
    .filter((c) => c.row.inputs !== null && c.prior !== null);

  it("has enough rows to mean something", () => {
    expect(cases.length).toBeGreaterThan(60);
  });

  it.each(cases.map((c) => [c.row.run_at, c] as const))("%s", (_runAt, { row, prior }) => {
    const inp = row.inputs!;
    const got = stepPanel(
      {
        vix: inp.vix,
        hy_spread_pct: inp.hySpread,
        sp500: inp.sp500,
        sp500_ath: inp.sp500Ath,
        treasury_10y: inp.treasury10y,
        sahm_rule: inp.sahmRule,
        fed_pivot_signal: row.fed_pivot_signal,
      },
      carryOf(prior!),
    ) as unknown as Record<string, unknown>;

    for (const k of COMPARED) expect(got[k], k).toEqual(row[k]);
    if (row.distance_to_red != null) expect(got.distance_to_red, "distance_to_red").toEqual(row.distance_to_red);
    if (row.run_at >= DD_VIX_LIVE_FROM) {
      expect(got.dd_vix_score, "dd_vix_score").toEqual(row.dd_vix_score);
      expect(got.dd_vix_band, "dd_vix_band").toEqual(row.dd_vix_band);
    }
    // Stored in numeric columns rounded to 2 decimals.
    expect(got.hy_spread_bps as number).toBeCloseTo(row.hy_spread_bps as number, 2);
    expect(got.sp_drawdown_pct as number).toBeCloseTo(row.sp_drawdown_pct as number, 2);
    if (row.sp500_trough === null) expect(got.sp500_trough, "sp500_trough").toBeNull();
    else expect(got.sp500_trough as number).toBeCloseTo(row.sp500_trough as number, 2);
  });

  it("covers the newer columns", () => {
    expect(COMPARED_WHEN_STORED.every((k) => cases.some((c) => c.row[k] != null))).toBe(true);
  });
});
