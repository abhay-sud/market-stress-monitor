// "Run your own" events and the daily brief. Pure: replayed days in, message
// text out. Every event is a transition between two consecutive replayed
// days, so the runner only needs to remember the last date it processed.

import type { DayState } from "./replay.js";
import type { NumericIndicator } from "../rules.js";

export interface LiteEvent {
  date: string;
  kind: "confirmed_red" | "left_red" | "stress_gate" | "risk_band" | "drawdown_line" | "recovery" | "stale_data" | "wave";
  title: string;
  body: string;
}

// A daily reading older than the S&P close it's shown with gets its date,
// e.g. the high-yield spread, which ICE posts the next morning. (The Sahm
// rule is monthly, so its date is never shown.)
const asOf = (d: DayState, k: "vix" | "hy_spread_pct" | "treasury_10y") =>
  d.inputs[k].observation_date < d.date ? ` (${shortDate(d.inputs[k].observation_date).slice(4)})` : "";

export const INDICATORS: { key: NumericIndicator; name: string; fmt: (d: DayState) => string }[] = [
  { key: "vix", name: "VIX", fmt: (d) => `${d.inputs.vix.value.toFixed(2)}${asOf(d, "vix")}` },
  { key: "hy_spread", name: "High-yield spread", fmt: (d) => `${Math.round(d.hy_spread_bps)} bp${asOf(d, "hy_spread_pct")}` },
  { key: "sp_drawdown", name: "S&P 500 drawdown", fmt: (d) => `${d.sp_drawdown_pct.toFixed(1)}%` },
  { key: "treasury_10y", name: "10-year Treasury", fmt: (d) => `${d.inputs.treasury_10y.value.toFixed(2)}%${asOf(d, "treasury_10y")}` },
  { key: "sahm_rule", name: "Sahm rule", fmt: (d) => d.inputs.sahm_rule.value.toFixed(2) },
];

const COLOR_KEY: Record<NumericIndicator, keyof DayState> = {
  vix: "vix_color",
  hy_spread: "hy_spread_color",
  sp_drawdown: "sp_drawdown_color",
  treasury_10y: "treasury_10y_color",
  sahm_rule: "sahm_rule_color",
};

// Drawdown risk band wording and historical rates: copied from
// dashboard_site/index.html (DD_VIX_BAND_LABELS / DD_VIX_HIT_RATE) and
// _worker.js; change them together (AGENTS.md "Making a rule change safely").
const BAND_LABEL: Record<string, string> = { LOW: "Low", TRANSITIONING: "Elevated", HIGH: "High" };
const BAND_HIT_RATE: Record<string, string> = { LOW: "5%", TRANSITIONING: "17%", HIGH: "44%" };
const TYPICAL_HIT_RATE = "12%";
const BAND_RANK: Record<string, number> = { LOW: 0, TRANSITIONING: 1, HIGH: 2 };

/** Drawdown lines that alert when crossed going down, re-armed once the drawdown recovers this many points. */
export const DRAWDOWN_LINES = [10, 20] as const;
export const DRAWDOWN_REARM_POINTS = 2;

/** Calendar days after which a series' latest reading counts as stale, relative to the S&P date. */
export const STALE_AFTER_DAYS: Record<"vix" | "hy_spread_pct" | "treasury_10y" | "sahm_rule", number> = {
  vix: 4,
  hy_spread_pct: 7,
  treasury_10y: 7,
  sahm_rule: 75, // monthly, published about five weeks after the month it describes
};
const SERIES_NAME: Record<keyof typeof STALE_AFTER_DAYS, string> = {
  vix: "VIX",
  hy_spread_pct: "High-yield spread",
  treasury_10y: "10-year Treasury",
  sahm_rule: "Sahm rule",
};

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export function staleSeries(d: DayState): string[] {
  return (Object.keys(STALE_AFTER_DAYS) as (keyof typeof STALE_AFTER_DAYS)[]).filter(
    (k) => daysBetween(d.inputs[k].observation_date, d.date) > STALE_AFTER_DAYS[k],
  );
}

const isConfirmedRed = (d: DayState, k: NumericIndicator) =>
  d[COLOR_KEY[k]] === "RED" && d.confirmation_state[k]?.color === "RED" && d.confirmation_state[k].confirmed;

const gateLine = (d: DayState) =>
  `${d.confirmed_red_count} of 6 confirmed RED; stress gate ${d.wave_authorized ? "met" : "not met"}.`;

/**
 * Every event in the replayed history, in date order. Drawdown-line alerts
 * use hysteresis (re-armed only after the drawdown recovers
 * DRAWDOWN_REARM_POINTS below the line), so a market hovering at a line
 * doesn't alert every day.
 */
export function detectEvents(days: DayState[]): LiteEvent[] {
  const events: LiteEvent[] = [];
  const armed = new Map<number, boolean>(DRAWDOWN_LINES.map((l) => [l, true]));
  for (let i = 0; i < days.length; i++) {
    const cur = days[i];
    const prev = i > 0 ? days[i - 1] : null;

    for (const line of DRAWDOWN_LINES) {
      if (cur.sp_drawdown_pct >= line && armed.get(line) && prev) {
        armed.set(line, false);
        events.push({
          date: cur.date,
          kind: "drawdown_line",
          title: `S&P 500 now ${cur.sp_drawdown_pct.toFixed(1)}% below its high`,
          body: `The S&P 500 closed at ${cur.inputs.sp500.value.toFixed(2)} on ${cur.date}, ${cur.sp_drawdown_pct.toFixed(1)}% below its all-time high of ${cur.inputs.sp500_ath.value.toFixed(2)} (${cur.inputs.sp500_ath.observation_date}): past the ${line}% line. ${gateLine(cur)}`,
        });
      } else if (cur.sp_drawdown_pct >= line) {
        armed.set(line, false); // already past the line when the history starts, or still past it
      } else if (cur.sp_drawdown_pct < line - DRAWDOWN_REARM_POINTS) {
        armed.set(line, true);
      }
    }
    if (!prev) continue;

    for (const ind of INDICATORS) {
      const was = isConfirmedRed(prev, ind.key);
      const now = isConfirmedRed(cur, ind.key);
      if (!was && now) {
        events.push({
          date: cur.date,
          kind: "confirmed_red",
          title: `${ind.name} confirmed RED`,
          body: `${ind.name} ${ind.fmt(cur)} has been RED on ${cur.confirmation_state[ind.key].days_confirmed} readings in a row (since ${cur.confirmation_state[ind.key].first_breach_date}), so it now counts toward the stress gate. ${gateLine(cur)}`,
        });
      } else if (was && cur[COLOR_KEY[ind.key]] !== "RED") {
        events.push({
          date: cur.date,
          kind: "left_red",
          title: `${ind.name} no longer RED`,
          body: `${ind.name} is ${ind.fmt(cur)} (${String(cur[COLOR_KEY[ind.key]])}). ${gateLine(cur)}`,
        });
      }
    }

    if (cur.wave_authorized !== prev.wave_authorized) {
      events.push({
        date: cur.date,
        kind: "stress_gate",
        title: cur.wave_authorized ? "Stress gate met" : "Stress gate no longer met",
        body: `${gateLine(cur)} The gate is information only; it doesn't decide anything on its own.`,
      });
    }

    // Rises only (Low -> Elevated -> High): the band moves with VIX and can
    // swing day to day, so falls are left to the brief.
    if (cur.dd_vix_band && prev.dd_vix_band && BAND_RANK[cur.dd_vix_band] > BAND_RANK[prev.dd_vix_band]) {
      events.push({
        date: cur.date,
        kind: "risk_band",
        title: `Drawdown risk: ${BAND_LABEL[prev.dd_vix_band]} → ${BAND_LABEL[cur.dd_vix_band]}`,
        body: riskBandSentence(cur),
      });
    }

    if (cur.recovery_confirmed && !prev.recovery_confirmed) {
      events.push({
        date: cur.date,
        kind: "recovery",
        title: "Recovery confirmed",
        body: `The S&P 500 is 15%+ above its trough of ${cur.sp500_trough?.toFixed(2)} (${cur.sp500_trough_date}), VIX has stayed below 25 for three weeks and the Fed pivot is CUT.`,
      });
    }

    const nowStale = staleSeries(cur).filter((s) => !staleSeries(prev).includes(s));
    for (const s of nowStale as (keyof typeof STALE_AFTER_DAYS)[]) {
      events.push({
        date: cur.date,
        kind: "stale_data",
        title: `${SERIES_NAME[s]} data is stale`,
        body: `The latest ${SERIES_NAME[s]} reading is from ${cur.inputs[s].observation_date}. Its colour carries forward until the source updates.`,
      });
    }
  }
  return events;
}

export function riskBandSentence(d: DayState): string {
  if (!d.dd_vix_band) {
    return `Drawdown risk band: not scored, because the S&P 500 is already ${d.sp_drawdown_pct.toFixed(1)}% below its high.`;
  }
  return (
    `Drawdown risk: ${BAND_LABEL[d.dd_vix_band]}. Historically, ${BAND_HIT_RATE[d.dd_vix_band]} of days in this band were followed ` +
    `by a 10%+ S&P 500 drawdown within 21 trading days, against ${TYPICAL_HIT_RATE} on a typical day.`
  );
}

const DISTANCE_UNIT: Record<NumericIndicator, (n: number) => string> = {
  vix: (n) => `${n.toFixed(1)} pts`,
  hy_spread: (n) => `${Math.round(n)} bp`,
  sp_drawdown: (n) => `${n.toFixed(1)} pts`,
  treasury_10y: (n) => `${n.toFixed(2)} pts`,
  sahm_rule: (n) => n.toFixed(2),
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

/** The daily brief. `fedPivotSet` is false when FED_PIVOT isn't configured. */
export function formatBrief(d: DayState, opts: { fedPivotSet: boolean }): { title: string; body: string } {
  const reds = INDICATORS.filter((i) => d[COLOR_KEY[i.key]] === "RED").map(
    (i) => `${i.name} ${i.fmt(d)} (${isConfirmedRed(d, i.key) ? "confirmed" : "not yet confirmed"})`,
  );
  const ambers = INDICATORS.filter((i) => d[COLOR_KEY[i.key]] === "AMBER").map((i) => `${i.name} ${i.fmt(d)}`);
  const floor = d.fed_facts?.cut_at_latest_decision === true;
  if (d.fed_pivot_color === "RED")
    reds.push(`Fed pivot ${d.inputs.fed_pivot_signal}${floor ? ` (the Fed cut ${-(d.fed_facts!.last_change_bp ?? 0)} bp, effective ${shortDate(d.fed_facts!.last_change_date!)})` : ""}`);
  if (d.fed_pivot_color === "AMBER") ambers.push(`Fed pivot ${d.inputs.fed_pivot_signal}`);

  // Closest to RED across different units: rank by the distance left as a
  // share of the indicator's own amber range (amber_from to red_above).
  const closest = INDICATORS.filter((i) => d[COLOR_KEY[i.key]] !== "RED")
    .map((i) => {
      const x = d.distance_to_red.indicators[i.key];
      return { i, dist: x.distance_to_red, share: x.distance_to_red / (x.red_above - x.amber_from) };
    })
    .filter((x) => x.dist >= 0)
    .sort((a, b) => a.share - b.share)
    .slice(0, 2)
    .map((x) => `${x.i.name} ${DISTANCE_UNIT[x.i.key](x.dist)} away`);

  const stale = staleSeries(d).map((s) => `${SERIES_NAME[s as keyof typeof STALE_AFTER_DAYS]} (last ${d.inputs[s as keyof typeof STALE_AFTER_DAYS].observation_date})`);

  const lines = [
    `${reds.length} of 6 RED${reds.length ? `: ${reds.join(" · ")}` : ""}`,
    ...(ambers.length ? [`${ambers.length} AMBER: ${ambers.join(" · ")}`] : []),
    `Stress gate: ${d.wave_authorized ? "met" : "not met"} (${d.confirmed_red_count} of 6 confirmed RED; the gate needs 3)`,
    riskBandSentence(d),
    ...(closest.length ? [`Closest to RED: ${closest.join(" · ")}`] : []),
    ...(opts.fedPivotSet || floor ? [] : ["Fed pivot: CUT only right after a Fed rate cut (for your own read, set the FED_PIVOT variable to NONE, PAUSE or CUT)"]),
    ...(stale.length ? [`Stale data: ${stale.join(", ")}`] : []),
    "Not investment advice · marketstress.org",
  ];
  return { title: `Market stress · ${shortDate(d.date)}`, body: lines.join("\n") };
}
