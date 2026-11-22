// Fed pivot input check for write_snapshot (2026-11-22). The daily Claude
// run judges the Fed pivot (NONE / PAUSE / CUT) with the written test in
// reference_docs/rules/project-instructions.md and gives a one-line reason.
// The rule engine's data floor (rule_engine/src/fedPivot.ts) wins: when the
// Fed's most recent decision was a cut, only CUT is accepted.

/** Mirrors rule_engine/src/fedPivot.ts FedPivotBasis (separate package). */
export interface FedPivotBasis {
  source: "data" | "ai" | "default";
  reason: string | null;
  decided_on: string | null;
  facts: {
    as_of: string;
    target_upper_pct: number;
    latest_meeting: string | null;
    last_change_date: string | null;
    last_change_bp: number | null;
    cut_at_latest_decision: boolean;
  } | null;
}

export const FED_PIVOT_REASON_MAX = 300;

/**
 * The basis to store with this snapshot. No signal given: the prior basis
 * carries. Signal given: needs a reason, must respect the floor, and becomes
 * an "ai" decision on the prior facts. Throws (nothing is written) otherwise.
 */
export function resolveFedPivotBasis(
  priorBasis: FedPivotBasis | null,
  signal: "NONE" | "PAUSE" | "CUT" | undefined,
  reasonInput: string | undefined,
  today: string,
): FedPivotBasis | null {
  if (signal === undefined) {
    if (reasonInput !== undefined) {
      throw new Error("fed_pivot_reason was given without fed_pivot_signal. Pass both, or neither. Nothing was written.");
    }
    return priorBasis;
  }
  const reason = (reasonInput ?? "").trim().replace(/\s+/g, " ");
  if (!reason) {
    throw new Error("fed_pivot_signal needs fed_pivot_reason: one line on why (the decision, statement or minutes it rests on). Nothing was written.");
  }
  if (reason.length > FED_PIVOT_REASON_MAX) {
    throw new Error(`fed_pivot_reason is ${reason.length} characters; keep it to one line (${FED_PIVOT_REASON_MAX}). Nothing was written.`);
  }
  const facts = priorBasis?.facts ?? null;
  if (facts?.cut_at_latest_decision && signal !== "CUT") {
    throw new Error(
      `fed_pivot_signal must be CUT: the Fed's most recent decision was a cut (${facts.last_change_bp} bp, effective ${facts.last_change_date}). ` +
        "The data floor can't be overridden. Nothing was written.",
    );
  }
  return { source: "ai", reason, decided_on: today, facts };
}
