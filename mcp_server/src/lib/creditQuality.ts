// CCC-minus-BB junk-bond spread gap (added 2026-11-25): how much more the
// weakest junk borrowers (CCC and lower) pay than the strongest (BB), from
// FRED's ICE BofA option-adjusted spreads BAMLH0A3HYC and BAMLH0A1HYBB.
// The weakest borrowers tend to crack first, so a widening gap while BB stays
// calm says stress is concentrated in weak credit rather than broad.
//
// Context only, never a rule input: FRED serves only about 3 years of ICE
// data (licensing), so the gap can't be backtested against past crashes. The
// percentile is over the trailing 3 years, the window FRED serves; the
// "widest 10%" flag is a display cutoff, not a tested threshold.
//
// dashboard_site/index.html mirrors this math (cccBbGap); change both together.

export const CCC_SERIES = "BAMLH0A3HYC";
export const BB_SERIES = "BAMLH0A1HYBB";
export const GAP_WINDOW_YEARS = 3;
export const GAP_CHANGE_DAYS = 28;
export const GAP_WIDE_PERCENTILE = 90;

export interface CreditQualitySummary {
  observation_date: string;
  ccc_oas_pct: number;
  bb_oas_pct: number;
  ccc_minus_bb_pts: number;
  change_4w_pts: number | null;
  percentile_3y: number;
  range_3y: { min: number; max: number; since: string };
  read: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ccc/bb: date -> OAS in percent. Returns null without a common latest day. */
export function summarizeCreditQuality(ccc: Map<string, number>, bb: Map<string, number>): CreditQualitySummary | null {
  const gap = [...ccc]
    .filter(([d]) => bb.has(d))
    .map(([d, v]) => ({ date: d, value: v - (bb.get(d) as number) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (gap.length === 0) return null;
  const last = gap[gap.length - 1];
  const start = shiftDays(last.date, -365 * GAP_WINDOW_YEARS);
  const win = gap.filter((p) => p.date >= start);
  const past = [...gap].reverse().find((p) => p.date <= shiftDays(last.date, -GAP_CHANGE_DAYS));
  const percentile = Math.round((win.filter((p) => p.value <= last.value).length / win.length) * 100);
  const vals = win.map((p) => p.value);
  const change = past ? r2(last.value - past.value) : null;
  const level = percentile >= GAP_WIDE_PERCENTILE ? `in the widest ${100 - GAP_WIDE_PERCENTILE}% of the last ${GAP_WINDOW_YEARS} years`
    : percentile <= 100 - GAP_WIDE_PERCENTILE ? `in the narrowest ${100 - GAP_WIDE_PERCENTILE}% of the last ${GAP_WINDOW_YEARS} years`
      : `within its ${GAP_WINDOW_YEARS}-year range`;
  return {
    observation_date: last.date,
    ccc_oas_pct: r2(ccc.get(last.date) as number),
    bb_oas_pct: r2(bb.get(last.date) as number),
    ccc_minus_bb_pts: r2(last.value),
    change_4w_pts: change,
    percentile_3y: percentile,
    range_3y: { min: r2(Math.min(...vals)), max: r2(Math.max(...vals)), since: win[0].date },
    read: `CCC-and-lower junk bonds pay ${r2(last.value).toFixed(2)} points more than BB, ${level}` +
      (change == null ? "" : `; ${change >= 0 ? "+" : ""}${change.toFixed(2)} points in 4 weeks`) + ".",
  };
}
