// "Run your own" (Tier 1) replay: rebuilds the panel state the daily Supabase
// run carries forward in crash_checks, from the raw histories alone, by
// stepping every S&P trading day through the same pure step (panelStep.ts).
// Pure: no I/O, no clock.
//
// On each S&P trading date the step sees each series' latest observation on
// or before that date, as the live run does. Confirmation streaks count
// distinct observation dates (rules.ts computeConfirmation), so replaying
// the history gives the streaks a daily run would have stored.

import { stepPanel, type FedPivotSignal, type PanelInputs, type PanelState } from "../panelStep.js";
import type { Point } from "./fetch.js";
import { sp500Derived } from "../sp500History.js";
import { fedRateFacts, floorForcesCut, type FedRateFacts } from "../fedPivot.js";

export { sp500Derived };

export interface ReplayInput {
  sp500: Point[];
  vix: Point[];
  hy_spread_pct: Point[];
  treasury_10y: Point[];
  sahm_rule: Point[];
  /** Fed target rate, upper end (FRED DFEDTARU). Optional: without it there is no data floor. */
  fed_target?: Point[];
}

export interface ReplayOptions {
  /** First S&P date to step through (earlier S&P history still sets the all-time high and the 252-day low). */
  from: string;
  /**
   * The Fed pivot outside the data floor: the FED_PIVOT setting, NONE by
   * default. On a day when the Fed's most recent decision was a cut
   * (fedPivot.ts), the day uses CUT instead, as the live engine does.
   */
  fedPivot: FedPivotSignal;
  /**
   * Date on which any open drawdown episode is forgotten. Defaults to the
   * date the current all-time high was set. At a new high the drawdown is
   * zero, and under the live recovery rules an episode only closes with a
   * Fed CUT, so without this an episode from years ago (for example April
   * 2025) would stay "open" and hide the current one's trough.
   */
  resetEpisodeOn?: string;
}

export interface DayState extends PanelState {
  date: string;
  inputs: PanelInputs;
  /** Trading days since the S&P closed at a 252-trading-day low (0 = today); see sp500History.ts. */
  sp500_days_since_252d_low: number;
  /** Fed rate facts for this day when the target-rate series was available. */
  fed_facts: FedRateFacts | null;
}

const byDate = (a: Point, b: Point) => a.date.localeCompare(b.date);

function clean(points: Point[]): Point[] {
  const m = new Map<string, number>();
  for (const p of points) if (Number.isFinite(p.value)) m.set(p.date, p.value);
  return [...m].map(([date, value]) => ({ date, value })).sort(byDate);
}

/** Latest point on or before `date`, advancing a cursor (dates must be visited in order). */
function asOf(series: Point[], cursor: { i: number }, date: string): Point | null {
  while (cursor.i + 1 < series.length && series[cursor.i + 1].date <= date) cursor.i++;
  return cursor.i >= 0 && series[cursor.i].date <= date ? series[cursor.i] : null;
}

const reading = (p: Point) => ({ value: p.value, observation_date: p.date });

export function replay(input: ReplayInput, opts: ReplayOptions): DayState[] {
  const sp = clean(input.sp500);
  const others = {
    vix: clean(input.vix),
    hy: clean(input.hy_spread_pct),
    dgs10: clean(input.treasury_10y),
    sahm: clean(input.sahm_rule),
  };
  const fedTarget = clean(input.fed_target ?? []);
  if (sp.length === 0) return [];
  const derived = sp500Derived(sp);
  const resetOn = opts.resetEpisodeOn ?? derived[derived.length - 1].ath.date;

  const cursors = { vix: { i: -1 }, hy: { i: -1 }, dgs10: { i: -1 }, sahm: { i: -1 } };
  const days: DayState[] = [];
  let prior: PanelState | null = null;

  for (let i = 0; i < sp.length; i++) {
    const date = sp[i].date;
    if (date < opts.from) continue;
    const vix = asOf(others.vix, cursors.vix, date);
    const hy = asOf(others.hy, cursors.hy, date);
    const dgs10 = asOf(others.dgs10, cursors.dgs10, date);
    const sahm = asOf(others.sahm, cursors.sahm, date);
    if (!vix || !hy || !dgs10 || !sahm) continue; // a series hasn't started yet
    const fedFacts = fedTarget.length ? fedRateFacts(fedTarget, date) : null;

    const inputs: PanelInputs = {
      vix: reading(vix),
      hy_spread_pct: reading(hy),
      sp500: reading(sp[i]),
      sp500_ath: reading(derived[i].ath),
      treasury_10y: reading(dgs10),
      sahm_rule: reading(sahm),
      fed_pivot_signal: floorForcesCut(fedFacts) ? "CUT" : opts.fedPivot,
    };
    const carry = prior && date === resetOn
      ? { ...prior, sp500_trough: null, sp500_trough_date: null, recovery_confirmed: false, recovery_confirmed_date: null }
      : prior;
    const state = stepPanel(inputs, carry);
    days.push({ ...state, date, inputs, sp500_days_since_252d_low: derived[i].daysSinceLow, fed_facts: fedFacts });
    prior = state;
  }
  return days;
}
