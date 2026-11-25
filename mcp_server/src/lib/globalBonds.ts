// Global bonds context (2026-11-25; crash-check-rules.md "Global bonds").
// Japan and Germany 10-year yields beside the US 10-year, plus dollar/yen
// and euro/dollar, each with a 4-week (28 calendar day) change. Context
// only: the M1 backtest (market-hazard-model experiments/m1_bond_stress,
// 2003-2026) found none of these adds to drawdown + VIX at 21 or 63
// trading days, so nothing here feeds red_count, the stress gate or waves.
// Mirrored by the dashboard's Global bonds card (dashboard_site/index.html
// renderGlobalBonds); change both together.
// Pure (no database import) so it can be tested; server.ts does the fetch.

export const GLOBAL_BOND_SERIES = ["DGS10", "BUND10", "JGB10", "DEXJPUS", "DEXUSEU"] as const;
export type GlobalBondSeries = (typeof GLOBAL_BOND_SERIES)[number];
export const CHANGE_WINDOW_DAYS = 28;

export interface Reading {
  value: number;
  date: string;
  /** Value on or before `date` minus CHANGE_WINDOW_DAYS, or null if there is none. */
  past: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const bp = (a: number, b: number) => Math.round((a - b) * 100);

/** Pure: turns latest + 4-weeks-ago readings into the tool's global_bonds block. */
export function summarizeGlobalBonds(x: Partial<Record<GlobalBondSeries, Reading | null>>) {
  const yieldRow = (r: Reading | null | undefined) =>
    r ? { value_pct: r.value, observation_date: r.date, change_4w_bp: r.past === null ? null : bp(r.value, r.past) } : null;
  const fxRow = (r: Reading | null | undefined) =>
    r ? { value: r.value, observation_date: r.date, change_4w_pct: r.past === null || r.past === 0 ? null : r2((r.value / r.past - 1) * 100) } : null;
  const us = x.DGS10, de = x.BUND10;
  const gap = us && de ? r2(us.value - de.value) : null;
  const gapChange = us && de && us.past !== null && de.past !== null ? bp(us.value - de.value, us.past - de.past) : null;
  return {
    us_10y: yieldRow(us),
    germany_10y: yieldRow(de),
    japan_10y: yieldRow(x.JGB10),
    us_minus_germany_10y_pct: gap,
    us_minus_germany_change_4w_bp: gapChange,
    // Positive = US yields rose more (or fell less) than German ones over 4 weeks.
    // The 10bp line is a reading aid, not a tested threshold.
    us_vs_germany_move: gapChange === null ? null : Math.abs(gapChange) < 10 ? "moved together (gap changed under 10bp)" : gapChange > 0 ? "US yields up relative to Germany" : "US yields down relative to Germany",
    usd_jpy: fxRow(x.DEXJPUS),
    eur_usd: fxRow(x.DEXUSEU),
  };
}
