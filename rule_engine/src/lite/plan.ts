// "Run your own" personal plan: the user's own wave triggers, pasted into the
// MY_PLAN secret as YAML (the wave_triggers block of
// local_state/policy.example.yaml). Evaluated over the replayed days with the
// same rules as the local wave alert:
//   mcp_server/src/lib/waveEvaluation.ts  evaluateWaveHistory (copied below)
//   mcp_server/src/lib/waveAlert.ts       decideWaveAlert + message (copied below)
// Copies, not imports, because the packages stay independent; keep them in
// step. Nothing here ever logs or returns a trigger level.

import { load } from "js-yaml";
import { computeConfirmation, MONITORING, type ConfirmationEntry } from "../rules.js";
import { NO_TRAILING_LOW } from "../sp500History.js";

export type WaveLevel = "NONE" | "WAVE_1" | "WAVE_2" | "WAVE_3";

export interface WaveTriggers {
  fast_panic: Record<"WAVE_1" | "WAVE_2" | "WAVE_3", { drawdown_pct_gte: number; vix_gt: number }>;
  slow_bear: {
    freshness_window_trading_days: number;
    WAVE_2: { drawdown_pct_gte: number };
    WAVE_3: { drawdown_pct_gte: number };
  };
}

/**
 * Parses MY_PLAN. Accepts either a document with a top-level `wave_triggers:`
 * key or the block itself. Errors name the missing or invalid key and never
 * echo a value (the secret may be printed in a public fork's log otherwise).
 */
export function parsePlan(text: string): WaveTriggers {
  let doc: unknown;
  try {
    doc = load(text);
  } catch {
    throw new Error("MY_PLAN is not valid YAML");
  }
  const root = (doc ?? {}) as Record<string, unknown>;
  const t = (root.wave_triggers ?? root) as Record<string, any>;
  const problems: string[] = [];
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  for (const w of ["WAVE_1", "WAVE_2", "WAVE_3"] as const) {
    const x = t?.fast_panic?.[w];
    if (!x || !num(x.drawdown_pct_gte) || !num(x.vix_gt)) problems.push(`fast_panic.${w} needs numeric drawdown_pct_gte and vix_gt`);
  }
  const sb = t?.slow_bear;
  if (!sb || !Number.isInteger(sb.freshness_window_trading_days) || sb.freshness_window_trading_days < 1) {
    problems.push("slow_bear.freshness_window_trading_days must be a whole number of at least 1");
  }
  for (const w of ["WAVE_2", "WAVE_3"] as const) {
    if (!sb?.[w] || !num(sb[w].drawdown_pct_gte)) problems.push(`slow_bear.${w} needs a numeric drawdown_pct_gte`);
  }
  if (problems.length) throw new Error(`MY_PLAN is invalid: ${problems.join("; ")}`);
  return t as unknown as WaveTriggers;
}

// ---- Copy of mcp_server/src/lib/waveEvaluation.ts (evaluation rules) ----

const RANK: Record<WaveLevel, number> = { NONE: 0, WAVE_1: 1, WAVE_2: 2, WAVE_3: 3 };

export interface WaveInputDay {
  date: string;
  drawdown_pct: number;
  vix: number;
  days_since_252d_low: number | null;
}

export interface WaveDay {
  date: string;
  wave: WaveLevel;
  reason: "FAST_PANIC" | "SLOW_BEAR" | null;
}

function fastPanicWave(drawdownPct: number, vix: number, t: WaveTriggers): WaveLevel {
  for (const w of ["WAVE_3", "WAVE_2", "WAVE_1"] as const) {
    const trig = t.fast_panic[w];
    if (drawdownPct >= trig.drawdown_pct_gte && vix > trig.vix_gt) return w;
  }
  return "NONE";
}

function slowBearConditions(drawdownPct: number, daysSinceLow: number, t: WaveTriggers): { w2: boolean; w3: boolean } {
  const fresh = daysSinceLow <= t.slow_bear.freshness_window_trading_days;
  return {
    w2: fresh && drawdownPct >= t.slow_bear.WAVE_2.drawdown_pct_gte,
    w3: fresh && drawdownPct >= t.slow_bear.WAVE_3.drawdown_pct_gte,
  };
}

/** Wave level on each day: the higher of fast panic and the confirmed slow-bear pathway (a tie reports FAST_PANIC). */
export function evaluateWaves(days: WaveInputDay[], t: WaveTriggers, requiredDays = MONITORING.confirmation_required_days): WaveDay[] {
  let w2: ConfirmationEntry | undefined;
  let w3: ConfirmationEntry | undefined;
  return days.map((d) => {
    const c = slowBearConditions(d.drawdown_pct, d.days_since_252d_low ?? NO_TRAILING_LOW, t);
    w2 = computeConfirmation(c.w2 ? "RED" : "GREEN", d.date, w2, requiredDays);
    w3 = computeConfirmation(c.w3 ? "RED" : "GREEN", d.date, w3, requiredDays);
    const fast = fastPanicWave(d.drawdown_pct, d.vix, t);
    const slow: WaveLevel = w3.color === "RED" && w3.confirmed ? "WAVE_3" : w2.color === "RED" && w2.confirmed ? "WAVE_2" : "NONE";
    const fastWins = RANK[fast] >= RANK[slow];
    const wave = fastWins ? fast : slow;
    return { date: d.date, wave, reason: wave === "NONE" ? null : fastWins ? "FAST_PANIC" : "SLOW_BEAR" };
  });
}

// ---- Copy of mcp_server/src/lib/waveAlert.ts (alert rule and wording) ----

/** Distinct observation dates with no wave before the alert re-arms. */
export const QUIET_DATES_TO_REARM = 10;

/**
 * Days on which a wave alert fires: the level rises above the last alerted
 * level; a dip and a return to the same or lower level stays quiet; after
 * QUIET_DATES_TO_REARM dates with no wave the alert re-arms.
 */
export function waveAlertDays(waves: WaveDay[]): WaveDay[] {
  let last: WaveLevel = "NONE";
  let quiet = 0;
  const fired: WaveDay[] = [];
  for (const w of waves) {
    if (RANK[w.wave] > RANK[last]) {
      fired.push(w);
      last = w.wave;
      quiet = 0;
    } else if (w.wave === "NONE") {
      if (last !== "NONE" && ++quiet >= QUIET_DATES_TO_REARM) {
        last = "NONE";
        quiet = 0;
      }
    } else {
      quiet = 0;
    }
  }
  return fired;
}

const NAME: Record<WaveLevel, string> = { NONE: "No wave", WAVE_1: "Wave 1", WAVE_2: "Wave 2", WAVE_3: "Wave 3" };

/** Alert text: which wave and the stress gate, never a trigger level or amount. */
export function waveAlertMessage(w: WaveDay, stressGateMet: boolean, confirmedReds: number): { title: string; body: string } {
  const how = w.reason === "SLOW_BEAR" ? " (slow bear)" : w.reason === "FAST_PANIC" ? " (fast panic)" : "";
  return {
    title: `${NAME[w.wave]} trigger hit`,
    body:
      `${NAME[w.wave]} trigger hit${how} on ${w.date}. Stress gate ${stressGateMet ? "met" : "not met"} ` +
      `(${confirmedReds} of 6 confirmed RED), information only. Your own plan says what to do.`,
  };
}
