// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeGlobalBonds, summarizeYenCarry } from "./globalBonds.js";

const r = (value: number, past: number | null) => ({ value, date: "2026-11-24", past });

test("yield changes in bp, FX changes in %, gap and its 4-week change", () => {
  const s = summarizeGlobalBonds({ DGS10: r(4.3, 4.0), BUND10: r(3.31, 3.21), JGB10: r(2.78, 2.82), DEXJPUS: r(150, 155), DEXUSEU: r(1.1, 1.1) });
  assert.equal(s.us_10y?.change_4w_bp, 30);
  assert.equal(s.germany_10y?.change_4w_bp, 10);
  assert.equal(s.japan_10y?.change_4w_bp, -4);
  assert.equal(s.us_minus_germany_10y_pct, 0.99);
  assert.equal(s.us_minus_germany_change_4w_bp, 20);
  assert.equal(s.us_vs_germany_move, "US yields up relative to Germany");
  assert.equal(s.usd_jpy?.change_4w_pct, -3.23); // yen strengthened
  assert.equal(s.eur_usd?.change_4w_pct, 0);
});

test("moves within 10bp of each other read as global; missing data gives nulls, not zeros", () => {
  const g = summarizeGlobalBonds({ DGS10: r(4.3, 4.2), BUND10: r(3.3, 3.25) });
  assert.equal(g.us_vs_germany_move, "moved together (gap changed under 10bp)");
  assert.equal(g.japan_10y, null);
  const n = summarizeGlobalBonds({ DGS10: r(4.3, null), BUND10: r(3.3, 3.25), DEXJPUS: r(150, null) });
  assert.equal(n.us_minus_germany_change_4w_bp, null);
  assert.equal(n.us_vs_germany_move, null);
  assert.equal(n.usd_jpy?.change_4w_pct, null);
});

test("yen carry: unwind rule needs both a 5% yen rise and crowding at the start", () => {
  const base = { levNet: { value: -8, date: "2024-08-06" }, assetMgrNet: { value: -6, date: "2024-08-06" }, us2y: r(3.89, 4.37), jgb2y: r(0.35, 0.33) };
  const aug2024 = summarizeYenCarry({ ...base, levNetBefore: -31.2, usdjpy: r(143.95, 153.39) });
  assert.equal(aug2024.usdjpy_change_2w_pct, -6.15);
  assert.equal(aug2024.unwind_rule_met, true);
  assert.equal(aug2024.crowded_short_yen, false); // crowding already gone by the latest report
  assert.equal(aug2024.us_minus_japan_2y_change_4w_bp, -50);
  assert.equal(summarizeYenCarry({ ...base, levNetBefore: -12, usdjpy: r(143.95, 153.39) }).unwind_rule_met, false);
  assert.equal(summarizeYenCarry({ ...base, levNetBefore: -31, usdjpy: r(150, 153) }).unwind_rule_met, false);
  assert.equal(summarizeYenCarry({ ...base, levNetBefore: null, usdjpy: r(150, 153) }).unwind_rule_met, null);
});
