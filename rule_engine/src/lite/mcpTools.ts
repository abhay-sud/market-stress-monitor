// Lightweight MCP mode: what each tool returns, built from the replayed days
// and the reader's files. Pure: no I/O, no clock. The server (mcp.ts) only
// fetches, replays and wires these to tool calls.

import type { DayState } from "./replay.js";
import { detectEvents, formatBrief, INDICATORS, riskBandSentence, staleSeries } from "./events.js";
import { evaluateWaves, waveAlertDays, waveAlertMessage, type WaveDay, type WaveLevel } from "./plan.js";
import { waveAmounts, accountDrift, type WaveAmounts } from "./money.js";
import { WAVES, type MyPlan, type MyPortfolio, type Wave } from "./myFiles.js";
import { floorForcesCut } from "../fedPivot.js";
import { MONITORING, type NumericIndicator } from "../rules.js";

export const DISCLAIMER = "Computed by code from public data and your own files; not investment advice.";

export interface DataMeta {
  fetched_at: string;
  stale: boolean;
  stale_reason?: string;
  sources: Record<string, string>;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

const COLOR_KEY: Record<NumericIndicator, keyof DayState> = {
  vix: "vix_color",
  hy_spread: "hy_spread_color",
  sp_drawdown: "sp_drawdown_color",
  treasury_10y: "treasury_10y_color",
  sahm_rule: "sahm_rule_color",
};

const BAND_LABEL: Record<string, string> = { LOW: "Low", TRANSITIONING: "Elevated", HIGH: "High" };

function dataBlock(meta: DataMeta) {
  return {
    fetched_at: meta.fetched_at,
    ...(meta.stale ? { stale: true, stale_reason: `Showing the last saved data; a refresh failed: ${meta.stale_reason}` } : {}),
    sources: meta.sources,
  };
}

/** Finds the replayed day for `date` (the latest on or before it), or the latest day. */
export function pickDay(days: DayState[], date?: string): DayState | { error: string } {
  if (!days.length) return { error: "No replayed days: a data source returned nothing." };
  if (!date) return days[days.length - 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "date must be YYYY-MM-DD" };
  if (date < days[0].date) return { error: `The replay starts on ${days[0].date}; ask for that date or later.` };
  let found = days[0];
  for (const d of days) if (d.date <= date) found = d;
  return found;
}

function fedPivotBlock(d: DayState, fedPivotSet: boolean) {
  const floor = floorForcesCut(d.fed_facts);
  return {
    signal: d.inputs.fed_pivot_signal,
    color: d.fed_pivot_color,
    set_by: floor ? "data floor: the Fed's most recent decision was a cut" : fedPivotSet ? "your FED_PIVOT setting" : "default (FED_PIVOT not set)",
    ...(d.fed_facts ? { rate_facts: d.fed_facts } : {}),
  };
}

/** get_reading */
export function reading(d: DayState, meta: DataMeta, opts: { fedPivotSet: boolean }) {
  const brief = formatBrief(d, opts);
  return {
    as_of: d.date,
    summary: { title: brief.title, lines: brief.body.split("\n") },
    indicators: INDICATORS.map((i) => {
      const dist = d.distance_to_red.indicators[i.key];
      const conf = d.confirmation_state[i.key];
      return {
        indicator: i.name,
        reading: i.fmt(d),
        value: r2(dist.value),
        observation_date: dist.observation_date,
        color: d[COLOR_KEY[i.key]],
        amber_from: dist.amber_from,
        red_above: dist.red_above,
        distance_to_red: r2(dist.distance_to_red),
        confirmed: !!conf?.confirmed,
        dates_at_this_color: conf?.days_confirmed ?? 0,
        ...(dist.color === "RED" ? { red_confirmation_dates_needed: dist.red_confirmation_days_needed } : {}),
      };
    }),
    fed_pivot: fedPivotBlock(d, opts.fedPivotSet),
    red_count: d.red_count,
    confirmed_red_count: d.confirmed_red_count,
    stress_gate: {
      met: d.wave_authorized,
      needs: `${MONITORING.stress_gate_confirmed_reds} of 6 confirmed RED`,
      required_for_deployment: MONITORING.stress_gate_required,
    },
    drawdown_risk_band: d.dd_vix_band
      ? { band: BAND_LABEL[d.dd_vix_band], score: d.dd_vix_score === null ? null : r2(d.dd_vix_score), meaning: riskBandSentence(d) }
      : { band: null, meaning: riskBandSentence(d) },
    sp500: {
      close: r2(d.inputs.sp500.value),
      all_time_high: r2(d.inputs.sp500_ath.value),
      all_time_high_date: d.inputs.sp500_ath.observation_date,
      drawdown_pct: r2(d.sp_drawdown_pct),
      episode_trough: d.sp500_trough === null ? null : r2(d.sp500_trough),
      episode_trough_date: d.sp500_trough_date,
      recovery_confirmed: d.recovery_confirmed,
      trading_days_since_252d_low: d.sp500_days_since_252d_low,
    },
    stale_series: staleSeries(d),
    data: dataBlock(meta),
    note: DISCLAIMER,
  };
}

/** get_changes: events over the last `n` replayed trading days, plus the reader's wave alerts if they have a plan. */
export function changes(days: DayState[], n: number, plan: MyPlan | null, meta: DataMeta) {
  const window = new Set(days.slice(-n).map((d) => d.date));
  const events: { date: string; kind: string; title: string; detail: string }[] = detectEvents(days)
    .filter((e) => window.has(e.date))
    .map((e) => ({ date: e.date, kind: e.kind, title: e.title, detail: e.body }));
  if (plan) {
    const byDate = new Map(days.map((d) => [d.date, d]));
    for (const w of waveAlertDays(waveHistory(days, plan)).filter((x) => window.has(x.date))) {
      const d = byDate.get(w.date)!;
      const m = waveAlertMessage(w, d.wave_authorized, d.confirmed_red_count);
      events.push({ date: w.date, kind: "your_wave", title: m.title, detail: m.body });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  const dates = [...window];
  return {
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    trading_days: dates.length,
    events,
    ...(events.length === 0 ? { message: "Nothing changed in this window: no indicator entered or left confirmed RED, and no gate, band, drawdown-line or recovery change." } : {}),
    data: dataBlock(meta),
  };
}

const RANK: Record<WaveLevel, number> = { NONE: 0, WAVE_1: 1, WAVE_2: 2, WAVE_3: 3 };
const WAVE_NAME: Record<Wave, string> = { WAVE_1: "Wave 1", WAVE_2: "Wave 2", WAVE_3: "Wave 3" };

function waveHistory(days: DayState[], plan: MyPlan): WaveDay[] {
  return evaluateWaves(
    days.map((d) => ({ date: d.date, drawdown_pct: d.sp_drawdown_pct, vix: d.inputs.vix.value, days_since_252d_low: d.sp500_days_since_252d_low })),
    plan.wave_triggers,
  );
}

/** get_my_plan */
export function myPlan(days: DayState[], plan: MyPlan, meta: DataMeta) {
  const waves = waveHistory(days, plan);
  const today = days[days.length - 1];
  const level = waves[waves.length - 1];
  const dd = today.sp_drawdown_pct;
  const vix = today.inputs.vix.value;
  const t = plan.wave_triggers;
  const required = MONITORING.confirmation_required_days;

  const perWave = WAVES.map((w) => {
    const armed = RANK[level.wave] >= RANK[w];
    let since: string | null = null;
    if (armed) for (let i = waves.length - 1; i >= 0 && RANK[waves[i].wave] >= RANK[w]; i--) since = waves[i].date;
    const fp = t.fast_panic[w];
    const fast = {
      trigger: `S&P 500 at least ${fp.drawdown_pct_gte}% below its high and VIX above ${fp.vix_gt}, on the same day`,
      met_today: dd >= fp.drawdown_pct_gte && vix > fp.vix_gt,
      drawdown_points_to_go: r1(Math.max(0, fp.drawdown_pct_gte - dd)),
      vix_points_to_go: vix > fp.vix_gt ? 0 : r2(fp.vix_gt - vix),
    };
    let slow = null;
    if (w !== "WAVE_1") {
      const sb = t.slow_bear[w];
      const met = (d: DayState) => d.sp500_days_since_252d_low <= t.slow_bear.freshness_window_trading_days && d.sp_drawdown_pct >= sb.drawdown_pct_gte;
      let streak = 0;
      for (let i = days.length - 1; i >= 0 && met(days[i]); i--) streak++;
      slow = {
        trigger:
          `S&P 500 at least ${sb.drawdown_pct_gte}% below its high, with a fresh one-year low within the last ` +
          `${t.slow_bear.freshness_window_trading_days} trading days, on ${required} trading dates in a row`,
        met_today: met(today),
        dates_met_in_a_row: streak,
        dates_needed: required,
        drawdown_points_to_go: r1(Math.max(0, sb.drawdown_pct_gte - dd)),
        trading_days_since_252d_low: today.sp500_days_since_252d_low,
      };
    }
    return {
      wave: WAVE_NAME[w],
      armed,
      ...(armed ? { armed_since: since, armed_by: level.reason === "SLOW_BEAR" ? "slow bear" : "fast panic" } : {}),
      executed_on: plan.executed[w] ?? null,
      fast_panic: fast,
      ...(slow ? { slow_bear: slow } : {}),
    };
  });

  const eligible = level.wave === "NONE" ? [] : WAVES.slice(0, RANK[level.wave]);
  const pending = eligible.filter((w) => !plan.executed[w]);
  const amounts = deployNow(plan, pending);

  return {
    as_of: today.date,
    current_level: level.wave === "NONE" ? "No wave armed" : `${WAVE_NAME[level.wave as Wave]} (${level.reason === "SLOW_BEAR" ? "slow bear" : "fast panic"})`,
    market: { drawdown_pct: r2(dd), vix: r2(vix), trading_days_since_252d_low: today.sp500_days_since_252d_low },
    waves: perWave,
    deploy_now: amounts,
    stress_gate: {
      met: today.wave_authorized,
      confirmed_red_count: today.confirmed_red_count,
      note: MONITORING.stress_gate_required
        ? "config/monitoring.yaml makes the stress gate a requirement: nothing deploys until it is met."
        : "Information only: wave triggers don't depend on the stress gate (stress_gate_required is false in config/monitoring.yaml).",
    },
    data: dataBlock(meta),
    note: `${DISCLAIMER} The triggers and amounts are your own plan's, not a recommendation.`,
  };
}

function deployNow(plan: MyPlan, pending: Wave[]) {
  if (pending.length === 0) return { waves: [], message: "Nothing to deploy now: no armed wave is waiting to be executed." };
  const names = pending.map((w) => WAVE_NAME[w]);
  const several = pending.length > 1 ? { several_pending: `${pending.length} waves are armed and not executed (${names.join(", ")}); your own plan decides how to stagger them.` } : {};
  if (!plan.waves) {
    return { waves: names, message: "Add a waves block to my_plan.yaml (each wave's share of your cash reserve and how it splits) to see amounts.", ...several };
  }
  const missing = pending.filter((w) => !plan.waves![w]);
  const defined = pending.filter((w) => plan.waves![w]);
  const lines = defined.map((w) => {
    const def = plan.waves![w]!;
    if (plan.cash_reserve_usd === null) {
      return { wave: WAVE_NAME[w], pct_of_reserve: def.pct_of_reserve, splits: def.splits };
    }
    const a: WaveAmounts = waveAmounts(def, plan.cash_reserve_usd);
    return { wave: WAVE_NAME[w], ...a };
  });
  const total =
    plan.cash_reserve_usd === null
      ? { total_pct_of_reserve: r2(lines.reduce((s, l) => s + l.pct_of_reserve, 0)), amounts: "Percent only: no cash_reserve_usd in my_plan.yaml." }
      : { total_usd: r2(lines.reduce((s, l) => s + ("total_usd" in l ? l.total_usd : 0), 0)), cash_reserve_usd: plan.cash_reserve_usd };
  return {
    waves: lines,
    ...total,
    ...(missing.length ? { not_in_waves_block: missing.map((w) => WAVE_NAME[w]) } : {}),
    ...several,
    cumulative: "Every armed wave not yet executed is included, so a fast fall that skips straight to a deeper wave returns the earlier ones too. Mark a wave done by adding its date under executed in my_plan.yaml.",
  };
}

/** get_portfolio_drift */
export function portfolioDrift(p: MyPortfolio) {
  const accounts = p.accounts.map((a) => accountDrift(a.name, a.holdings_pct, a.target_pct));
  return {
    accounts,
    rule: "A holding is DRIFTED when it is further from its target than the smaller of 5 points or 25% of its target (never under 2 points).",
    note: "Computed by code from your own file; not investment advice.",
  };
}
