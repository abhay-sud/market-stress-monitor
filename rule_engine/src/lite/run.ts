// "Run your own" (Tier 1) entry point: `npm run lite [-- --dry-run]`.
// Fetches the six panel inputs from public sources, replays them through the
// live engine's rules and prints today's state. Event detection,
// notifications and the personal plan come in the next build steps
// (reference_docs/BUILD_SPEC_run_your_own.md).

import { fetchLiteHistory } from "./fetch.js";
import { replay, type DayState } from "./replay.js";
import type { FedPivotSignal } from "../panelStep.js";

const REPLAY_YEARS = 2;

function fedPivotSetting(): FedPivotSignal {
  const v = (process.env.FED_PIVOT ?? "").trim().toUpperCase();
  if (v === "" || v === "NONE") return "NONE";
  if (v === "PAUSE" || v === "CUT") return v;
  throw new Error(`FED_PIVOT must be NONE, PAUSE or CUT (got an unrecognised value)`);
}

export function summarize(d: DayState): string {
  const fmt = (n: number, dp = 2) => n.toFixed(dp);
  const lines = [
    `As of ${d.date}`,
    `VIX ${fmt(d.inputs.vix.value)} ${d.vix_color} · HY spread ${fmt(d.hy_spread_bps, 0)}bp ${d.hy_spread_color} · ` +
      `S&P drawdown ${fmt(d.sp_drawdown_pct, 1)}% ${d.sp_drawdown_color} · 10Y ${fmt(d.inputs.treasury_10y.value)}% ${d.treasury_10y_color} · ` +
      `Sahm ${fmt(d.inputs.sahm_rule.value)} ${d.sahm_rule_color} · Fed pivot ${d.inputs.fed_pivot_signal} ${d.fed_pivot_color}`,
    `RED ${d.red_count} of 6, confirmed ${d.confirmed_red_count}; stress gate ${d.wave_authorized ? "met" : "not met"}`,
    `Drawdown risk band: ${d.dd_vix_band ?? "not scored (drawdown already 10%+)"}`,
    `Drawdown episode: ${d.sp500_trough !== null ? `trough ${fmt(d.sp500_trough)} on ${d.sp500_trough_date}` : "none"}; ` +
      `trading days since a 252-day low: ${d.sp500_days_since_252d_low}`,
  ];
  return lines.join("\n");
}

async function main() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error("FRED_API_KEY is not set (free key: https://fred.stlouisfed.org/docs/api/api_key.html)");
  const fedPivot = fedPivotSetting();
  const from = new Date(Date.now() - REPLAY_YEARS * 365.25 * 86400_000).toISOString().slice(0, 10);

  const history = await fetchLiteHistory(apiKey, from);
  console.log(`Sources: ${Object.entries(history.sources).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  const days = replay(history, { from, fedPivot });
  if (days.length === 0) throw new Error("No days to replay: a series returned no data");
  console.log(summarize(days[days.length - 1]));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
