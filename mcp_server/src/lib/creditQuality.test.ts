import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCreditQuality } from "./creditQuality.js";

function series(start: string, days: number, f: (i: number) => number): Map<string, number> {
  const m = new Map<string, number>();
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    m.set(d.toISOString().slice(0, 10), f(i));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return m;
}

test("gap, 4-week change and percentile over common days", () => {
  // CCC rises steadily from 8 to ~12; BB flat at 2. Last day is the widest.
  const ccc = series("2024-01-01", 1000, (i) => 8 + i * 0.004);
  const bb = series("2024-01-01", 1000, () => 2);
  const s = summarizeCreditQuality(ccc, bb)!;
  assert.equal(s.observation_date, "2026-09-26");
  assert.equal(s.ccc_minus_bb_pts, 10);
  assert.equal(s.percentile_3y, 100);
  assert.equal(s.change_4w_pts, Math.round(28 * 0.004 * 100) / 100);
  assert.match(s.read, /widest 10% of the last 3 years/);
  assert.equal(s.range_3y.max, s.ccc_minus_bb_pts);
});

test("uses only days both series have, and null without overlap", () => {
  const ccc = new Map([["2026-11-20", 13.8], ["2026-11-23", 13.87]]);
  const bb = new Map([["2026-11-20", 2.07]]);
  const s = summarizeCreditQuality(ccc, bb)!;
  assert.equal(s.observation_date, "2026-11-20");
  assert.equal(s.ccc_minus_bb_pts, 11.73);
  assert.equal(s.change_4w_pts, null);
  assert.equal(summarizeCreditQuality(new Map([["2026-11-23", 1]]), new Map()), null);
});
