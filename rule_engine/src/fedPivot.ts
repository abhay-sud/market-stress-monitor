// Fed pivot signal: data facts + a floor (2026-11-22).
//
// The Fed pivot (panel indicator 6: NONE / PAUSE / CUT) asks one question:
// has the Fed turned toward easing? The daily Claude run judges it with the
// written test in reference_docs/rules/project-instructions.md, and this file
// gives that judgment its facts and a floor:
//
// - Facts: from FRED's Fed target rate (DFEDTARU, the upper end of the
//   target range) and the FOMC calendar: the latest scheduled decision, the
//   most recent rate change and whether that change was a cut.
// - Floor: if the Fed's most recent decision was a cut (a cut that took
//   effect after the latest scheduled meeting; an intermeeting cut counts
//   too), the signal is CUT and the AI can't set anything else. A cut at an
//   earlier meeting doesn't force CUT: the AI judges whether the easing
//   still stands (a hawkish turn after a cut is NONE).
//
// Before the calendar's first date there is no latest meeting to compare
// with, so the floor stays off there (an honest "can't tell", not a guess).
// Pure functions only; shared by classify.ts and the "run your own" replay.

export type FedPivotSignal = "NONE" | "PAUSE" | "CUT";

/**
 * FOMC decision days (each meeting's second day), copied from
 * mcp_server/src/lib/economicCalendar.ts FOMC_MEETINGS (sourced from
 * federalreserve.gov/monetarypolicy/fomccalendars.htm). Change them
 * together: fedPivot.test.ts checks the two lists match.
 */
export const FOMC_DECISION_DATES: readonly string[] = [
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
  "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08",
];

/** FRED series for the upper end of the Fed's target range. */
export const FED_TARGET_SERIES = "DFEDTARU";

export interface FedRateFacts {
  as_of: string;
  target_upper_pct: number;
  /** Latest scheduled FOMC decision day before `as_of` (null before the calendar starts). */
  latest_meeting: string | null;
  last_change_date: string | null;
  last_change_bp: number | null;
  /** The Fed's most recent decision was a cut: the floor that forces CUT. */
  cut_at_latest_decision: boolean;
}

export interface FedPivotBasis {
  source: "data" | "ai" | "default";
  reason: string | null;
  decided_on: string | null;
  facts: FedRateFacts | null;
}

/**
 * Rate facts as of `asOf` from daily target-rate points. A decision takes
 * effect the day after the meeting, so the latest meeting is the last one
 * strictly before `asOf`. Null when there is no data on or before `asOf`.
 */
export function fedRateFacts(
  points: { date: string; value: number }[],
  asOf: string,
  meetings: readonly string[] = FOMC_DECISION_DATES,
): FedRateFacts | null {
  const pts = points.filter((p) => p.date <= asOf).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (pts.length === 0) return null;

  let lastChangeDate: string | null = null;
  let lastChangeBp: number | null = null;
  for (let i = pts.length - 1; i > 0; i--) {
    const bp = Math.round((pts[i].value - pts[i - 1].value) * 100);
    if (bp !== 0) {
      lastChangeDate = pts[i].date;
      lastChangeBp = bp;
      break;
    }
  }

  const before = meetings.filter((m) => m < asOf);
  const latestMeeting = meetings.length && asOf > meetings[0] ? before[before.length - 1] : null;

  return {
    as_of: pts[pts.length - 1].date,
    target_upper_pct: pts[pts.length - 1].value,
    latest_meeting: latestMeeting,
    last_change_date: lastChangeDate,
    last_change_bp: lastChangeBp,
    cut_at_latest_decision:
      latestMeeting !== null && lastChangeBp !== null && lastChangeBp < 0 && lastChangeDate !== null && lastChangeDate > latestMeeting,
  };
}

/** True when the facts force CUT, so a different signal must be refused. */
export const floorForcesCut = (facts: FedRateFacts | null | undefined): boolean => facts?.cut_at_latest_decision === true;

/**
 * The rule engine's daily step: apply the floor, otherwise carry the prior
 * signal (set by the AI, or the default) with refreshed facts. A missing
 * facts value (data unavailable) leaves the prior signal and facts as they were.
 */
export function decideFedPivot(
  prior: { signal: FedPivotSignal | null; basis: FedPivotBasis | null } | null,
  facts: FedRateFacts | null,
  today: string,
): { signal: FedPivotSignal; basis: FedPivotBasis } {
  const priorSignal = prior?.signal ?? "NONE";
  const priorBasis = prior?.basis ?? null;

  if (facts && floorForcesCut(facts)) {
    const same = priorBasis?.source === "data" && priorBasis.facts?.last_change_date === facts.last_change_date;
    return {
      signal: "CUT",
      basis: {
        source: "data",
        reason: `The Fed cut ${-(facts.last_change_bp ?? 0)} bp (effective ${facts.last_change_date}); its most recent decision was a cut.`,
        decided_on: same ? priorBasis!.decided_on : today,
        facts,
      },
    };
  }

  const basis: FedPivotBasis = priorBasis
    ? { ...priorBasis, facts: facts ?? priorBasis.facts }
    : { source: "default", reason: null, decided_on: null, facts };
  return { signal: priorSignal, basis };
}
