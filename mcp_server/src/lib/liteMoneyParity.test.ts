// The lightweight MCP mode (rule_engine/src/lite/money.ts) keeps copies of
// computeWaveDeployment and the per-fund part of computePortfolioDrift. Both
// packages check the same fixture, so the copies can't drift apart silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeWaveDeployment, type Policy } from "./waveDeployment.js";
import { computePortfolioDrift } from "./portfolio.js";

const fixture = JSON.parse(readFileSync(new URL("../../../config/fixtures/lite-money.json", import.meta.url), "utf-8"));

test("wave amounts match the shared fixture", () => {
  for (const c of fixture.waves) {
    const def = {
      pct_of_dry_powder: c.wave.pct_of_reserve,
      splits: c.wave.splits.map((s: { name: string; pct_of_wave: number }, i: number) => ({ fund: s.name, pct_of_wave: s.pct_of_wave, slot: `slot_${i}` })),
    };
    // computeWaveDeployment reads only policy.waves[wave].
    const r = computeWaveDeployment("WAVE_1", c.reserve_usd, { waves: { WAVE_1: def } } as unknown as Policy);
    assert.deepEqual({ pct_of_reserve: r.pct_of_dry_powder, total_usd: r.total_usd, splits_usd: r.splits.map((s) => s.usd) }, c.expected);
  }
});

test("portfolio drift matches the shared fixture", () => {
  for (const c of fixture.drift) {
    const { accounts } = computePortfolioDrift({ accounts: { main: { holdings_pct: c.holdings_pct, long_term_target_pct: c.target_pct } } });
    const a = accounts[0];
    const entries = a.entries.map(({ fund, label: _label, ...rest }) => ({ holding: fund, ...rest }));
    assert.deepEqual({ entries, max_drift_pts: a.max_drift_pts, has_drifted: a.has_drifted }, c.expected);
  }
});
