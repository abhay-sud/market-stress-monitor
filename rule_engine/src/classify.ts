import { getLatestDataPoint, getLatestCrashCheck, getSeriesSince, insertCrashCheck } from "./lib/supabase.js";
import { decideFedPivot, fedRateFacts, FED_TARGET_SERIES, type FedPivotSignal, type FedRateFacts } from "./fedPivot.js";
import { computeDivergences } from "./divergence.js";
import { gatherHazardFeatures, computeHazardProbability, type HazardResult } from "./hazardModel.js";
import { updateHazardScorecard } from "./hazardScorecardStore.js";
import { updateScenarioScorecard } from "./scenarioScorecardStore.js";
import { stepPanel } from "./panelStep.js";
import { daysSinceTrailingLow as computeDaysSinceTrailingLow } from "./lib/seriesDelta.js";

async function requireLatest(seriesId: string) {
  const point = await getLatestDataPoint(seriesId);
  if (!point) {
    throw new Error(
      `No data_points row found for required series "${seriesId}" — has the ingestion Action run yet?`,
    );
  }
  return point;
}

export async function classify(): Promise<void> {
  const [vix, hySpread, sp500, sp500Ath, treasury10y, sahmRule] = await Promise.all([
    requireLatest("VIXCLS"),
    requireLatest("BAMLH0A0HYM2"),
    requireLatest("SP500"),
    requireLatest("SP500_ATH"),
    requireLatest("DGS10"),
    requireLatest("SAHMREALTIME"),
  ]);

  // Fed pivot signal (fedPivot.ts): judged by the daily Claude run and
  // carried forward here, except that a cut at the Fed's most recent
  // decision forces CUT (the data floor). Facts come from the Fed target
  // rate; if they can't be read, the prior value carries unchanged.
  const prior = await getLatestCrashCheck();
  if (!prior) {
    console.warn('No prior crash_checks row found — defaulting fed_pivot_signal to "NONE" until the daily run judges it.');
  }
  const today = new Date().toISOString().slice(0, 10);
  let fedFacts: FedRateFacts | null = null;
  try {
    const since = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    const rows = await getSeriesSince(FED_TARGET_SERIES, since);
    fedFacts = fedRateFacts(rows.map((r) => ({ date: r.observation_date, value: Number(r.value) })), today);
  } catch (err) {
    console.error("fedPivot: couldn't read the Fed target rate; carrying the prior signal:", err);
  }
  const fedPivot = decideFedPivot(
    prior ? { signal: prior.fed_pivot_signal as FedPivotSignal | null, basis: prior.fed_pivot_basis ?? null } : null,
    fedFacts,
    today,
  );
  const fedPivotSignal = fedPivot.signal;

  // Bands, confirmation streaks, stress gate, distance-to-RED, the drawdown
  // + VIX risk band and the Stage 4 trough/recovery state: one pure step
  // (panelStep.ts), shared with the stateless "run your own" replay.
  const panel = stepPanel(
    {
      vix,
      hy_spread_pct: hySpread,
      sp500,
      sp500_ath: sp500Ath,
      treasury_10y: treasury10y,
      sahm_rule: sahmRule,
      fed_pivot_signal: fedPivotSignal,
    },
    prior,
  );
  const {
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
    confirmation_state: confirmationState,
    wave_authorized: waveAuthorized,
    distance_to_red: distanceToRed,
    in_episode: inEpisode,
    dd_vix_score: ddVixScore,
    dd_vix_band: ddVixBand,
    sp500_trough: sp500Trough,
    sp500_trough_date: sp500TroughDate,
    recovery_confirmed: recoveryConfirmed,
    recovery_confirmed_date: recoveryConfirmedDate,
  } = panel;

  // Trading days since the S&P set a 252-trading-day low: a public market
  // input to the slow-bear wave check, which runs locally in mcp_server
  // (waveEvaluation.ts) because the wave triggers are personal policy.
  // Counted from the stored S&P closes each run (see seriesDelta.ts), not
  // carried forward, so extra runs on the same close don't inflate it.
  const daysSinceTrailingLow = await computeDaysSinceTrailingLow(sp500.observation_date);

  const divergenceFlags = await computeDivergences();

  // Statistical Hazard Model (10% drawdown target) — see
  // reference_docs/rules/crash-check-rules.md "Statistical Hazard Model".
  // Additive, non-gating cross-check: NOT part of the 3-of-6 wave-
  // authorization gate above, and never blended with crash_probability_pct
  // (which is 100% LLM judgment). Wrapped in try/catch deliberately, unlike
  // the hard-throw requireLatest() convention for the 6 core indicators —
  // those gate real deployment decisions and must never silently go stale;
  // a transient gap in one of the hazard model's own input series should
  // degrade to null fields, not block the core panel refresh.
  //
  // Eligibility gate (external review 2026-09-19, F01): the model's target
  // is a FUTURE breach conditional on not already being in a >=10% drawdown
  // — it does not answer "how much worse from here" once already past that
  // threshold. Score only when live drawdown < 10%; otherwise record
  // ALREADY_BREACHED and leave raw/calibrated/band null rather than
  // presenting an out-of-population number as if it still applied.
  let hazard: HazardResult | null = null;
  let hazardFeatures: Record<string, number> | null = null;
  let hazardStatus: "ELIGIBLE" | "ALREADY_BREACHED" | "UNAVAILABLE";
  if (drawdown >= 10) {
    hazardStatus = "ALREADY_BREACHED";
  } else {
    try {
      hazardFeatures = await gatherHazardFeatures({
        vixValue: vix.value,
        dgs10Value: treasury10y.value,
        sahmValue: sahmRule.value,
        drawdownPctLive: drawdown,
        anchorDate: sp500.observation_date,
      });
      hazard = computeHazardProbability(hazardFeatures);
      hazardStatus = "ELIGIBLE";
    } catch (err) {
      console.error("hazardModel: failed to compute, nulling out this run's hazard fields:", err);
      hazardStatus = "UNAVAILABLE";
    }
  }

  await insertCrashCheck({
    sp500_level: sp500.value,
    sp500_as_of: sp500.observation_date,
    sp500_ath: sp500Ath.value,
    sp500_ath_date: sp500Ath.observation_date,
    vix_value: vix.value,
    vix_color: vixColor,
    hy_spread_bps: hySpreadBps,
    hy_spread_color: hySpreadColor,
    sp_drawdown_pct: drawdown,
    sp_drawdown_color: spDrawdownColor,
    treasury_10y_pct: treasury10y.value,
    treasury_10y_color: treasury10yColor,
    sahm_rule_value: sahmRule.value,
    sahm_rule_color: sahmRuleColor,
    fed_pivot_signal: fedPivotSignal,
    fed_pivot_color: fedPivotColor,
    fed_pivot_basis: fedPivot.basis,
    red_count: redCount,
    confirmed_red_count: confirmedRedCount,
    confirmation_state: confirmationState,
    wave_authorized: waveAuthorized,
    sp500_days_since_252d_low: daysSinceTrailingLow,
    warsh_classification: (prior?.warsh_classification as "HAWKISH" | "MODERATE" | "DOVISH" | "PENDING" | null) ?? "PENDING",
    warsh_classification_date: prior?.warsh_classification_date ?? null,
    warsh_hard_rules_active: prior?.warsh_hard_rules_active ?? false,
    trigger_status: prior?.trigger_status ?? [],
    divergence_flags: divergenceFlags,
    distance_to_red: distanceToRed,
    sp500_trough: sp500Trough,
    sp500_trough_date: sp500TroughDate,
    recovery_confirmed: recoveryConfirmed,
    recovery_confirmed_date: recoveryConfirmedDate,
    hazard_10pct_raw_pct: hazard ? Math.round(hazard.raw_probability * 10000) / 100 : null,
    hazard_10pct_calibrated_pct: hazard ? Math.round(hazard.calibrated_probability * 10000) / 100 : null,
    hazard_10pct_band: hazard?.band ?? null,
    hazard_10pct_as_of: hazard ? sp500.observation_date : null,
    hazard_10pct_status: hazardStatus,
    dd_vix_score: ddVixScore,
    dd_vix_band: ddVixBand,
    raw_source_data: {
      vix, hySpread, sp500, sp500Ath, treasury10y, sahmRule,
      hazard_model_raw_probability: hazard?.raw_probability ?? null,
      note: "warsh_* fields carried forward from prior row; fed_pivot_signal carried forward unless the data floor forces CUT (see fed_pivot_basis)",
    },
  });

  console.log(
    `Classified: ${redCount}/6 RED (${confirmedRedCount} confirmed) (VIX=${vixColor}, HY=${hySpreadColor}, ` +
      `Drawdown=${spDrawdownColor}, 10y=${treasury10yColor}, Sahm=${sahmRuleColor}, FedPivot=${fedPivotSignal} (${fedPivot.basis.source})). ` +
      `Stress gate met: ${waveAuthorized}. ` +
      `Drawdown episode: ${inEpisode ? `active (trough ${sp500Trough} on ${sp500TroughDate})` : "none"}. ` +
      `Recovery confirmed: ${recoveryConfirmed}. ` +
      `Drawdown + VIX band: ${ddVixBand ?? "not scored (drawdown >= 10%)"}. ` +
      `Hazard model (scorecard only): ${hazard ? `${hazard.band} (raw score ${(hazard.raw_probability * 100).toFixed(1)}%)` : hazardStatus}.`,
  );

  // Hazard scorecard (rebuild brief Stage 0): record today's model band
  // next to the drawdown + VIX baseline, and score earlier days whose
  // outcome window has closed. Report-only and non-gating, so a failure
  // here is logged and never fails the run.
  try {
    // A row for every day the question applies (drawdown < 10%), even when
    // the model itself failed to compute: the band needs only drawdown + VIX.
    const msg = await updateHazardScorecard(
      drawdown < 10
        ? {
            as_of_date: sp500.observation_date,
            model_band: hazard?.band ?? null,
            model_raw_pct: hazard ? Math.round(hazard.raw_probability * 10000) / 100 : null,
            sp500_level: sp500.value,
            sp500_ath: sp500Ath.value,
            drawdown_pct: drawdown,
            vix: vix.value,
            inputs: hazardFeatures,
          }
        : null,
    );
    console.log(msg);
  } catch (err) {
    console.error("hazardScorecard: update failed (non-gating):", err);
  }

  // Scenario scorecard: tilt-based full reports and their 63-day outcomes.
  // Report-only and non-gating, like the hazard scorecard above.
  try {
    console.log(await updateScenarioScorecard());
  } catch (err) {
    console.error("scenarioScorecard: update failed (non-gating):", err);
  }

  // The "2 confirmed RED" push alert was retired 2026-11-19 (a backtest found it never warned
  // before the 10% point); the wave-trigger alert runs locally (mcp_server/src/scripts/waveAlert.ts).
}
