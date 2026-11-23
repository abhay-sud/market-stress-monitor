// Lightweight MCP mode: the two money calculations, copied from mcp_server so
// this package stays independent. Change them together: a shared fixture
// (config/fixtures/lite-money.json) is checked by a test in each package
// (AGENTS.md "Making a rule change safely"). Pure: no I/O.

export interface WaveSplitDef {
  name: string;
  pct_of_wave: number;
}

export interface WaveDef {
  pct_of_reserve: number;
  splits: WaveSplitDef[];
}

export interface WaveAmounts {
  pct_of_reserve: number;
  total_usd: number;
  splits: { name: string; pct_of_wave: number; usd: number }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Copy of computeWaveDeployment (mcp_server/src/lib/waveDeployment.ts): a wave's share of the reserve, split by pct_of_wave. */
export function waveAmounts(def: WaveDef, reserveUsd: number): WaveAmounts {
  const waveUsd = (def.pct_of_reserve / 100) * reserveUsd;
  return {
    pct_of_reserve: def.pct_of_reserve,
    total_usd: round2(waveUsd),
    splits: def.splits.map((s) => ({ name: s.name, pct_of_wave: s.pct_of_wave, usd: round2((s.pct_of_wave / 100) * waveUsd) })),
  };
}

export interface DriftEntry {
  holding: string;
  actual_pct: number;
  target_pct: number;
  drift_pts: number;
  threshold_pts: number;
  status: "ON_TARGET" | "DRIFTED";
}

export interface AccountDrift {
  account: string;
  entries: DriftEntry[];
  max_drift_pts: number;
  has_drifted: boolean;
}

/**
 * Copy of driftThresholdPts (mcp_server/src/lib/portfolio.ts), the 5/25
 * rule: the smaller of 5 points or 25% of the holding's own target, with a
 * 2-point floor so rounding noise on small targets doesn't flag.
 */
export function driftThresholdPts(targetPct: number): number {
  return Math.max(2, Math.min(5, targetPct * 0.25));
}

/** Copy of the per-holding part of computePortfolioDrift (mcp_server/src/lib/portfolio.ts). */
export function accountDrift(account: string, holdings: Record<string, number>, target: Record<string, number>): AccountDrift {
  const names = new Set([...Object.keys(holdings), ...Object.keys(target)]);
  const entries: DriftEntry[] = [...names].map((holding) => {
    const actual = holdings[holding] ?? 0;
    const tgt = target[holding] ?? 0;
    const drift = Math.round((actual - tgt) * 10) / 10;
    const threshold = driftThresholdPts(tgt);
    return { holding, actual_pct: actual, target_pct: tgt, drift_pts: drift, threshold_pts: threshold, status: Math.abs(drift) > threshold ? "DRIFTED" : "ON_TARGET" };
  });
  entries.sort((a, b) => Math.abs(b.drift_pts) - Math.abs(a.drift_pts));
  return {
    account,
    entries,
    max_drift_pts: entries.length > 0 ? Math.max(...entries.map((e) => Math.abs(e.drift_pts))) : 0,
    has_drifted: entries.some((e) => e.status === "DRIFTED"),
  };
}
