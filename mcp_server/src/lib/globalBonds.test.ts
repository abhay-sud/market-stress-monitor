// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeGlobalBonds } from "./globalBonds.js";

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
