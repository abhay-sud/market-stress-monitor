// Pure S&P 500 history measures shared by the daily run (classify.ts, via
// lib/seriesDelta.ts) and the "run your own" replay (lite/replay.ts).

export interface Point {
  date: string;
  value: number;
}

/** Trailing window for the slow-bear "fresh ~1-year low" (crash-check-rules.md). */
export const TRAILING_LOW_WINDOW = 252;

/** Returned when no 252-day low exists in the supplied history: never "fresh". */
export const NO_TRAILING_LOW = 9999;

/**
 * For each close (ascending by date): the running all-time high, and the
 * number of TRADING DAYS (closes) since the S&P last closed at or below
 * every close in its trailing 252-close window, the day itself included
 * (0 = today is such a low; ties count). Counted from the closes, so it can't
 * drift with how often the engine runs.
 */
export function sp500Derived(sp: Point[]): { ath: Point; daysSinceLow: number }[] {
  const out: { ath: Point; daysSinceLow: number }[] = [];
  let ath: Point | null = null;
  let lastLow = -1;
  // Monotonic deque of indices with non-decreasing closes: the front is the window minimum.
  const dq: number[] = [];
  for (let i = 0; i < sp.length; i++) {
    if (!ath || sp[i].value > ath.value) ath = sp[i];
    while (dq.length && sp[dq[dq.length - 1]].value > sp[i].value) dq.pop();
    dq.push(i);
    while (dq[0] <= i - TRAILING_LOW_WINDOW) dq.shift();
    if (sp[i].value <= sp[dq[0]].value) lastLow = i;
    out.push({ ath, daysSinceLow: lastLow < 0 ? NO_TRAILING_LOW : i - lastLow });
  }
  return out;
}
