import { supabase, getLatestDataPoint } from "./supabase.js";
import { sp500Derived, NO_TRAILING_LOW, type Point } from "../sp500History.js";

/**
 * 7-day calendar-day delta for a data_points series — mirrors
 * mcp_server/src/lib/seriesDelta.ts's computeSeriesDelta() (duplicated
 * rather than shared across the package boundary, same convention as
 * ConfirmationEntry elsewhere in this codebase). Only computes the 7-day
 * window, not 3-day too — this is purpose-built for divergence detection
 * (computeDivergences() below), not a general-purpose delta tool; the
 * MCP-server-side get_series_deltas remains the one for ad-hoc 3-day/7-day
 * queries from chat.
 */
export function subtractDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function getValueOnOrBefore(seriesId: string, onOrBeforeDate: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("data_points")
    .select("value")
    .eq("series_id", seriesId)
    .lte("observation_date", onOrBeforeDate)
    .order("observation_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read historical data_point for ${seriesId} on/before ${onOrBeforeDate}: ${error.message}`);
  }
  return data?.value ?? null;
}

// Same bps-scaling convention as mcp_server's seriesDelta.ts — HY/IG credit
// spreads are stored as raw percent but reported in bps everywhere else.
const BPS_SERIES = new Set(["BAMLH0A0HYM2", "BAMLC0A0CM"]);

export interface SeriesDelta7d {
  value: number | null;
  delta_7d: number | null;
}

export async function computeSeriesDelta7d(seriesId: string): Promise<SeriesDelta7d> {
  const latest = await getLatestDataPoint(seriesId);
  if (!latest) return { value: null, delta_7d: null };

  const scale = BPS_SERIES.has(seriesId) ? 100 : 1;
  const v7 = await getValueOnOrBefore(seriesId, subtractDays(latest.observation_date, 7));
  const round = (n: number) => Math.round(n * 1000) / 1000;

  return {
    value: round(latest.value * scale),
    delta_7d: v7 !== null ? round((latest.value - v7) * scale) : null,
  };
}

/**
 * N-calendar-day delta anchored to a caller-supplied date/value, rather than
 * re-fetching "latest" independently per series (computeSeriesDelta7d's own
 * behavior, left unchanged above for divergence.ts). Throws (does not
 * return null) on missing history — a hazard feature computed from a
 * silently-missing delta would be wrong, not just incomplete; see
 * hazardModel.ts's own fail-loud convention.
 */
export async function computeSeriesDeltaAsOf(
  seriesId: string,
  anchorDate: string,
  anchorValue: number,
  days: number
): Promise<number> {
  return computeSeriesDeltaAsOfDate(seriesId, anchorValue, subtractDays(anchorDate, days));
}

/**
 * Same delta computation as computeSeriesDeltaAsOf, but takes an explicit
 * target date instead of deriving one via calendar subtraction — the
 * building block for computeSeriesDeltaAsOf's calendar-day case (above) and
 * for getTradingDayAnchor's trading-day-exact case (below).
 */
export async function computeSeriesDeltaAsOfDate(seriesId: string, anchorValue: number, targetDate: string): Promise<number> {
  const past = await getValueOnOrBefore(seriesId, targetDate);
  if (past === null) {
    throw new Error(`computeSeriesDeltaAsOfDate: no historical data_point for "${seriesId}" on/before ${targetDate}`);
  }
  return Math.round((anchorValue - past) * 100000) / 100000;
}

/**
 * Resolves the actual trading-day-exact date N trading days before
 * anchorDate, by counting back N rows in a reference market-calendar series
 * (SP500 — already this system's authoritative index for drawdown/ATH/wave
 * triggers, so reusing it as the trading-day calendar reference is
 * consistent with existing conventions) rather than approximating with
 * calendar-day subtraction. hazardModel.ts's research was validated on
 * exact 5/20-trading-day deltas; this closes that previously-flagged
 * calendar-day approximation (crash-check-rules.md's "Known production
 * approximation") for good, rather than leaving it as a permanent caveat.
 * Assumes SP500 has no gaps on real trading days — true in practice for
 * this system's core index series, but not independently re-verified here.
 */
export async function getTradingDayAnchor(anchorDate: string, tradingDaysBack: number): Promise<string> {
  const { data, error } = await supabase
    .from("data_points")
    .select("observation_date")
    .eq("series_id", "SP500")
    .lte("observation_date", anchorDate)
    .order("observation_date", { ascending: false })
    .limit(tradingDaysBack + 1);

  if (error) {
    throw new Error(`getTradingDayAnchor: failed reading SP500 history on/before ${anchorDate}: ${error.message}`);
  }
  if (!data || data.length < tradingDaysBack + 1) {
    throw new Error(
      `getTradingDayAnchor: fewer than ${tradingDaysBack + 1} SP500 rows on/before ${anchorDate} — cannot resolve a ${tradingDaysBack}-trading-day anchor yet.`,
    );
  }
  return data[tradingDaysBack].observation_date;
}

/**
 * Trading days since the S&P last closed at a fresh 252-trading-day low, as
 * of `anchorDate` (0 = that day is one). A fresh ~1-year low, not just
 * "below some old all-time high", backs the slow-bear wave pathway (added
 * 2026-09-19): it distinguishes an actively deteriorating market from one
 * that's merely still below a stale multi-year-old peak (SPY didn't reclaim
 * its Oct-2007 high until 2013).
 *
 * Counted from the stored SP500 closes (sp500History.ts, shared with the
 * "run your own" replay). Until 2026-11-22 the count was carried forward as
 * the prior row's value plus one, so it rose on every run (two or three a
 * trading day, Saturdays included) rather than every trading day, which
 * would have made the slow-bear freshness window, set in trading days,
 * expire two to three times too early. NO_TRAILING_LOW (9999) when the
 * stored history holds no such low.
 */
export async function daysSinceTrailingLow(anchorDate: string): Promise<number> {
  const closes: Point[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("data_points")
      .select("observation_date, value")
      .eq("series_id", "SP500")
      .lte("observation_date", anchorDate)
      .order("observation_date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      throw new Error(`daysSinceTrailingLow: failed reading SP500 history on/before ${anchorDate}: ${error.message}`);
    }
    closes.push(...(data ?? []).map((d) => ({ date: d.observation_date as string, value: Number(d.value) })));
    if (!data || data.length < PAGE) break;
  }
  const derived = sp500Derived(closes);
  return derived.length ? derived[derived.length - 1].daysSinceLow : NO_TRAILING_LOW;
}
