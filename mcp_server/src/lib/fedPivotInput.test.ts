import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFedPivotBasis, type FedPivotBasis } from "./fedPivotInput.js";

const facts = (cut: boolean): FedPivotBasis["facts"] => ({
  as_of: "2026-11-20",
  target_upper_pct: cut ? 3.75 : 4.0,
  latest_meeting: "2026-10-28",
  last_change_date: cut ? "2026-10-29" : "2026-09-17",
  last_change_bp: -25,
  cut_at_latest_decision: cut,
});
const basis = (cut: boolean): FedPivotBasis => ({ source: "default", reason: null, decided_on: null, facts: facts(cut) });

test("no signal: the prior basis carries; a lone reason is refused", () => {
  const prior = basis(false);
  assert.equal(resolveFedPivotBasis(prior, undefined, undefined, "2026-11-22"), prior);
  assert.throws(() => resolveFedPivotBasis(prior, undefined, "why", "2026-11-22"), /without fed_pivot_signal/);
});

test("a signal needs a one-line reason", () => {
  assert.throws(() => resolveFedPivotBasis(basis(false), "NONE", "  ", "2026-11-22"), /needs fed_pivot_reason/);
  assert.throws(() => resolveFedPivotBasis(basis(false), "NONE", "x".repeat(301), "2026-11-22"), /301 characters/);
});

test("the AI's call is stored with its reason and the rule engine's facts", () => {
  const r = resolveFedPivotBasis(basis(false), "NONE", "Held Oct 28,\n10-2 with two dissents for a hike; hawkish.", "2026-11-22");
  assert.deepEqual(r, { source: "ai", reason: "Held Oct 28, 10-2 with two dissents for a hike; hawkish.", decided_on: "2026-11-22", facts: facts(false) });
});

test("a cut at the most recent decision forces CUT", () => {
  assert.throws(() => resolveFedPivotBasis(basis(true), "NONE", "Statement hawkish.", "2026-11-22"), /must be CUT/);
  assert.throws(() => resolveFedPivotBasis(basis(true), "PAUSE", "On hold next.", "2026-11-22"), /must be CUT/);
  assert.equal(resolveFedPivotBasis(basis(true), "CUT", "Cut 25 bp on Oct 28.", "2026-11-22")?.source, "ai");
});

test("an earlier cut (not the most recent decision) leaves the call to the AI", () => {
  assert.equal(resolveFedPivotBasis(basis(false), "NONE", "Cut in Sep, then a hawkish hold in Oct.", "2026-11-22")?.reason, "Cut in Sep, then a hawkish hold in Oct.");
});
