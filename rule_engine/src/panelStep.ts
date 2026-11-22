// One day of the 6-indicator panel, as a pure function: bands, confirmation
// streaks, the stress gate, distance-to-RED, the drawdown + VIX risk band and
// the Stage 4 drawdown-episode / recovery state. Extracted from classify.ts
// (2026-11-22) so the daily Supabase run and the stateless "run your own"
// replay (src/lite/) apply exactly the same logic. No I/O, no clock.
//
// Thresholds come from rules.ts / config/monitoring.yaml and the band from
// hazardScorecard.ts; nothing here restates them.

import { baselineScore, bandBaseline } from "./hazardScorecard.js";
import type { HazardBand } from "./hazardModel.js";
import {
  bandVix,
  bandHySpreadBps,
  bandSpDrawdownPct,
  bandTreasury10y,
  bandSahmRule,
  bandFedPivotSignal,
  bandVixRecovery,
  isRecoveredFromTrough,
  countReds,
  isWaveAuthorized,
  drawdownPct,
  computeConfirmation,
  computeDistanceToRed,
  type Color,
  type ConfirmationEntry,
  type DistanceToRed,
} from "./rules.js";

export type FedPivotSignal = "NONE" | "PAUSE" | "CUT";

export interface Reading {
  value: number;
  observation_date: string;
}

export interface PanelInputs {
  vix: Reading;
  /** FRED BAMLH0A0HYM2, in percent (converted to bps here). */
  hy_spread_pct: Reading;
  sp500: Reading;
  /** All-time high; observation_date is the date it was set. */
  sp500_ath: Reading;
  treasury_10y: Reading;
  sahm_rule: Reading;
  fed_pivot_signal: FedPivotSignal;
}

/** The fields of the previous day's state that today's step depends on. */
export interface PanelCarry {
  confirmation_state: Record<string, ConfirmationEntry> | null;
  sp500_trough: number | null;
  sp500_trough_date: string | null;
  recovery_confirmed: boolean;
  recovery_confirmed_date: string | null;
}

export interface PanelState extends PanelCarry {
  confirmation_state: Record<string, ConfirmationEntry>;
  hy_spread_bps: number;
  sp_drawdown_pct: number;
  vix_color: Color;
  hy_spread_color: Color;
  sp_drawdown_color: Color;
  treasury_10y_color: Color;
  sahm_rule_color: Color;
  fed_pivot_color: Color;
  red_count: number;
  confirmed_red_count: number;
  /** Stress gate met (stored as crash_checks.wave_authorized). */
  wave_authorized: boolean;
  distance_to_red: DistanceToRed;
  /** Drawdown is >= 10% on this step. (An episode stays open past this until recovery is confirmed: see sp500_trough.) */
  in_episode: boolean;
  dd_vix_score: number | null;
  dd_vix_band: HazardBand | null;
}

export function stepPanel(inputs: PanelInputs, prior: PanelCarry | null): PanelState {
  const { vix, hy_spread_pct, sp500, sp500_ath, treasury_10y, sahm_rule, fed_pivot_signal } = inputs;

  const hySpreadBps = hy_spread_pct.value * 100; // FRED reports BAMLH0A0HYM2 in percent
  const drawdown = drawdownPct(sp500.value, sp500_ath.value);

  const vixColor = bandVix(vix.value);
  const hySpreadColor = bandHySpreadBps(hySpreadBps);
  const spDrawdownColor = bandSpDrawdownPct(drawdown);
  const treasury10yColor = bandTreasury10y(treasury_10y.value);
  const sahmRuleColor = bandSahmRule(sahm_rule.value);
  const fedPivotColor = bandFedPivotSignal(fed_pivot_signal);

  const redCount = countReds([vixColor, hySpreadColor, spDrawdownColor, treasury10yColor, sahmRuleColor, fedPivotColor]);

  // Signal Tiering & Confirmation Windows (crash-check-rules.md v5): each of
  // the 5 numeric Tier-1 indicators must hold its color across 2+ distinct
  // observation dates before it counts toward the stress gate. Fed pivot
  // signal has no numeric series behind it (a manual judgment, carried
  // forward by the caller), so it's excluded from this mechanism and its RED
  // state (if any) counts toward confirmed_red_count immediately.
  const priorConfirmation = prior?.confirmation_state ?? {};
  const confirmationState: Record<string, ConfirmationEntry> = {
    vix: computeConfirmation(vixColor, vix.observation_date, priorConfirmation.vix),
    hy_spread: computeConfirmation(hySpreadColor, hy_spread_pct.observation_date, priorConfirmation.hy_spread),
    sp_drawdown: computeConfirmation(spDrawdownColor, sp500.observation_date, priorConfirmation.sp_drawdown),
    treasury_10y: computeConfirmation(treasury10yColor, treasury_10y.observation_date, priorConfirmation.treasury_10y),
    sahm_rule: computeConfirmation(sahmRuleColor, sahm_rule.observation_date, priorConfirmation.sahm_rule),
  };

  const confirmedRedCount =
    Object.values(confirmationState).filter((c) => c.color === "RED" && c.confirmed).length +
    (fedPivotColor === "RED" ? 1 : 0);

  // Distance-to-RED (E7): read-only view of the same 5 readings and their
  // confirmation streaks. Computed before the vix_recovery key is added, and
  // never read back by any count or gate decision.
  const distanceToRed = computeDistanceToRed(
    {
      vix: { value: vix.value, observation_date: vix.observation_date, confirmation: confirmationState.vix },
      hy_spread: { value: hySpreadBps, observation_date: hy_spread_pct.observation_date, confirmation: confirmationState.hy_spread },
      sp_drawdown: { value: drawdown, observation_date: sp500.observation_date, confirmation: confirmationState.sp_drawdown },
      treasury_10y: { value: treasury_10y.value, observation_date: treasury_10y.observation_date, confirmation: confirmationState.treasury_10y },
      sahm_rule: { value: sahm_rule.value, observation_date: sahm_rule.observation_date, confirmation: confirmationState.sahm_rule },
    },
    { level: sp500.value, ath: sp500_ath.value },
    { state: fed_pivot_signal, color: fedPivotColor },
  );
  const waveAuthorized = isWaveAuthorized(confirmedRedCount);

  // Drawdown + VIX risk band: the public answer to "could a 10% drawdown
  // start within ~21 trading days?" since 2026-11-17. Not scored once the
  // drawdown is already >= 10% (the question no longer applies).
  const ddVixScore = drawdown < 10 ? Math.round(baselineScore(drawdown, vix.value) * 100) / 100 : null;
  const ddVixBand = ddVixScore === null ? null : bandBaseline(baselineScore(drawdown, vix.value));

  // Stage 4 recovery tracking (crash-check-rules.md "Recovery Signal and
  // 6-Month Transition"). The trough is a running minimum for the CURRENT
  // OPEN episode: "open" means drawdown reached >=10% at some point and
  // recovery hasn't been confirmed yet, not merely "drawdown is >=10% right
  // now" (external review 2026-09-19, F08: the trough must survive a pullback
  // under 10% so the 15% rebound can still be measured against it).
  // wasEpisodeOpen is captured before this step's own trough update.
  const wasEpisodeOpen = (prior?.sp500_trough ?? null) !== null && !(prior?.recovery_confirmed ?? false);
  const inEpisode = drawdown >= 10;
  let sp500Trough = prior?.sp500_trough ?? null;
  let sp500TroughDate = prior?.sp500_trough_date ?? null;
  if (inEpisode) {
    if (!wasEpisodeOpen || sp500Trough === null || sp500.value < sp500Trough) {
      // A fresh episode is starting, or this day set a new deeper low.
      sp500Trough = sp500.value;
      sp500TroughDate = sp500.observation_date;
    }
  } else if (!wasEpisodeOpen) {
    // Under 10% with no open episode: nothing to track.
    sp500Trough = null;
    sp500TroughDate = null;
  }
  // else: back under 10% but the episode is still open; keep the trough.

  // Criterion 3 (VIX sustained below 25 for 3+ weeks) reuses
  // computeConfirmation with requiredCount 15 under its own key.
  const vixRecoveryEntry = computeConfirmation(bandVixRecovery(vix.value), vix.observation_date, priorConfirmation.vix_recovery, 15);
  confirmationState.vix_recovery = vixRecoveryEntry;

  const recoveryCriterion1 = sp500Trough !== null && isRecoveredFromTrough(sp500.value, sp500Trough);
  // Criterion 2 reuses fed_pivot_signal as-is.
  const recoveryCriterion2 = fed_pivot_signal === "CUT";
  const recoveryCriterion3 = vixRecoveryEntry.color === "GREEN" && vixRecoveryEntry.confirmed;

  // recovery_confirmed is a historical fact about the most recent episode:
  // once true it stays true until a new episode begins. Its date is set
  // once, on the step it first becomes true.
  let recoveryConfirmed = prior?.recovery_confirmed ?? false;
  let recoveryConfirmedDate = prior?.recovery_confirmed_date ?? null;
  if (inEpisode && !wasEpisodeOpen) {
    recoveryConfirmed = false;
    recoveryConfirmedDate = null;
  }
  if (!recoveryConfirmed && recoveryCriterion1 && recoveryCriterion2 && recoveryCriterion3) {
    recoveryConfirmed = true;
    recoveryConfirmedDate = sp500.observation_date;
  }

  return {
    confirmation_state: confirmationState,
    hy_spread_bps: hySpreadBps,
    sp_drawdown_pct: drawdown,
    vix_color: vixColor,
    hy_spread_color: hySpreadColor,
    sp_drawdown_color: spDrawdownColor,
    treasury_10y_color: treasury10yColor,
    sahm_rule_color: sahmRuleColor,
    fed_pivot_color: fedPivotColor,
    red_count: redCount,
    confirmed_red_count: confirmedRedCount,
    wave_authorized: waveAuthorized,
    distance_to_red: distanceToRed,
    in_episode: inEpisode,
    dd_vix_score: ddVixScore,
    dd_vix_band: ddVixBand,
    sp500_trough: sp500Trough,
    sp500_trough_date: sp500TroughDate,
    recovery_confirmed: recoveryConfirmed,
    recovery_confirmed_date: recoveryConfirmedDate,
  };
}
