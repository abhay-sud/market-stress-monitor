// "Run your own": which messages a run sends, and the small state it keeps
// for the next run. Pure; run.ts does the fetching, sending and saving.
//
// The only state between runs (kept in the Actions cache) holds no market or
// personal data: the last S&P date processed, the last brief date, and the
// date a stale-S&P alert was last sent. Everything else is rebuilt by the
// replay. If the cache is lost, the run alerts only on the latest date.

import type { DayState } from "./replay.js";
import { detectEvents, formatBrief, shortDate, type LiteEvent } from "./events.js";
import { evaluateWaves, waveAlertDays, waveAlertMessage, type WaveTriggers } from "./plan.js";
import type { Message } from "./notify.js";

export interface LiteState {
  last_date: string | null;
  last_brief_date: string | null;
  sp500_stale_alerted_for: string | null;
}

export const EMPTY_STATE: LiteState = { last_date: null, last_brief_date: null, sp500_stale_alerted_for: null };

export type BriefMode = "daily" | "weekly" | "off";

export function briefMode(raw: string | undefined): BriefMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "daily") return "daily";
  if (v === "weekly" || v === "off") return v;
  throw new Error("BRIEF must be daily, weekly or off");
}

/** More public events than this in one run are sent as a single digest. */
export const MAX_SEPARATE_EVENTS = 3;

/** No new S&P close for this many calendar days counts as a data problem (covers long weekends). */
export const SP500_STALE_AFTER_DAYS = 5;

export interface RunDecision {
  messages: (Message & { personal: boolean })[];
  next: LiteState;
  /** Safe for a public log: no plan values and no wave levels. */
  log: string[];
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export function decideRun(
  days: DayState[],
  state: LiteState,
  opts: { brief: BriefMode; runDate: string; plan: WaveTriggers | null; fedPivotSet: boolean },
): RunDecision {
  const latest = days[days.length - 1];
  const log: string[] = [];
  const messages: RunDecision["messages"] = [];
  const isNew = (date: string) => (state.last_date ? date > state.last_date : date === latest.date);

  const events: LiteEvent[] = detectEvents(days).filter((e) => isNew(e.date));
  if (events.length > MAX_SEPARATE_EVENTS) {
    // After a gap (missed runs, a lost cache), one digest instead of a burst of pushes.
    messages.push({
      title: `${events.length} market stress alerts since ${shortDate(events[0].date)}`,
      body: events.map((e) => `${shortDate(e.date)}: ${e.title}. ${e.body}`).join("\n\n"),
      priority: "high",
      personal: false,
    });
  } else {
    for (const e of events) messages.push({ title: e.title, body: `${shortDate(e.date)}: ${e.body}`, priority: "high", personal: false });
  }

  if (opts.plan) {
    const byDate = new Map(days.map((d) => [d.date, d]));
    const waves = evaluateWaves(
      days.map((d) => ({ date: d.date, drawdown_pct: d.sp_drawdown_pct, vix: d.inputs.vix.value, days_since_252d_low: d.sp500_days_since_252d_low })),
      opts.plan,
    );
    const fired = waveAlertDays(waves).filter((w) => isNew(w.date));
    for (const w of fired) {
      const d = byDate.get(w.date)!;
      messages.push({ ...waveAlertMessage(w, d.wave_authorized, d.confirmed_red_count), priority: "high", personal: true });
    }
    if (fired.length) log.push(`plan: ${fired.length} wave alert(s) to send (details go to your channels only)`);
  }

  let staleFor = state.sp500_stale_alerted_for;
  if (daysBetween(latest.date, opts.runDate) > SP500_STALE_AFTER_DAYS && staleFor !== latest.date) {
    messages.push({
      title: "No new S&P 500 close",
      body: `The latest S&P 500 close is from ${latest.date}. If markets were open since, a data source may be down; this run used the last known values.`,
      priority: "high",
      personal: false,
    });
    staleFor = latest.date;
  }

  const newDay = !state.last_date || latest.date > state.last_date;
  const isFriday = new Date(`${opts.runDate}T12:00:00Z`).getUTCDay() === 5;
  const briefDue =
    opts.brief === "daily"
      ? state.last_brief_date !== latest.date && newDay
      : opts.brief === "weekly"
        ? isFriday && state.last_brief_date !== latest.date
        : false;
  if (briefDue) messages.push({ ...formatBrief(latest, { fedPivotSet: opts.fedPivotSet }), priority: "default", personal: false });

  log.push(
    `latest S&P date ${latest.date}; ${events.length} event(s); brief ${briefDue ? "due" : opts.brief === "off" ? "off" : "not due"}`,
  );
  return {
    messages,
    next: {
      last_date: latest.date > (state.last_date ?? "") ? latest.date : state.last_date,
      last_brief_date: briefDue ? latest.date : state.last_brief_date,
      sp500_stale_alerted_for: staleFor,
    },
    log,
  };
}
