import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decideFedPivot, fedRateFacts, FOMC_DECISION_DATES, type FedPivotBasis } from "./fedPivot.js";

// Daily target-rate points between two dates, stepping to `after` on `changeOn`.
function series(from: string, to: string, before: number, changeOn: string | null, after = before) {
  const out: { date: string; value: number }[] = [];
  for (let d = new Date(from + "T00:00:00Z"); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    out.push({ date, value: changeOn && date >= changeOn ? after : before });
  }
  return out;
}

describe("rate facts", () => {
  it("a cut effective the day after the latest meeting is a cut at the latest decision", () => {
    const f = fedRateFacts(series("2026-08-01", "2026-11-20", 4.0, "2026-10-29", 3.75), "2026-11-20")!;
    expect(f).toMatchObject({ latest_meeting: "2026-10-28", last_change_date: "2026-10-29", last_change_bp: -25, cut_at_latest_decision: true, target_upper_pct: 3.75 });
  });

  it("a cut at the meeting before, then a hold, is not (the AI decides)", () => {
    const f = fedRateFacts(series("2026-08-01", "2026-11-20", 4.25, "2026-09-17", 4.0), "2026-11-20")!;
    expect(f).toMatchObject({ latest_meeting: "2026-10-28", last_change_bp: -25, cut_at_latest_decision: false });
  });

  it("a hike or no change is never a cut", () => {
    expect(fedRateFacts(series("2026-08-01", "2026-11-20", 4.0, "2026-10-29", 4.25), "2026-11-20")!.cut_at_latest_decision).toBe(false);
    expect(fedRateFacts(series("2026-08-01", "2026-11-20", 4.0, null), "2026-11-20")).toMatchObject({ last_change_date: null, cut_at_latest_decision: false });
  });

  it("an intermeeting cut after the latest meeting counts", () => {
    expect(fedRateFacts(series("2026-08-01", "2026-11-20", 4.0, "2026-11-12", 3.5), "2026-11-20")).toMatchObject({ last_change_bp: -50, cut_at_latest_decision: true });
  });

  it("on the meeting day itself the latest meeting is the one before", () => {
    expect(fedRateFacts(series("2026-08-01", "2026-10-28", 4.0, null), "2026-10-28")!.latest_meeting).toBe("2026-09-16");
  });

  it("before the calendar starts there is no latest meeting, so no floor", () => {
    const f = fedRateFacts(series("2025-11-01", "2026-01-20", 4.0, "2025-12-11", 3.75), "2026-01-20")!;
    expect(f).toMatchObject({ latest_meeting: null, last_change_bp: -25, cut_at_latest_decision: false });
  });

  it("only uses points on or before the as-of date", () => {
    expect(fedRateFacts(series("2026-11-01", "2026-11-20", 4.0, null), "2026-10-01")).toBeNull();
  });
});

describe("daily decision", () => {
  const cutFacts = fedRateFacts(series("2026-08-01", "2026-11-20", 4.0, "2026-10-29", 3.75), "2026-11-20");
  const holdFacts = fedRateFacts(series("2026-08-01", "2026-11-20", 4.0, null), "2026-11-20");
  const ai: FedPivotBasis = { source: "ai", reason: "Held; hawkish.", decided_on: "2026-11-19", facts: null };

  it("the floor forces CUT over the AI's NONE, and keeps its first date", () => {
    const d = decideFedPivot({ signal: "NONE", basis: ai }, cutFacts, "2026-11-22");
    expect(d.signal).toBe("CUT");
    expect(d.basis).toMatchObject({ source: "data", decided_on: "2026-11-22", reason: expect.stringMatching(/cut 25 bp \(effective 2026-10-29\)/) });
    expect(decideFedPivot({ signal: "CUT", basis: d.basis }, cutFacts, "2026-11-23").basis.decided_on).toBe("2026-11-22");
  });

  it("otherwise the prior signal and who set it carry, with fresh facts", () => {
    const d = decideFedPivot({ signal: "PAUSE", basis: ai }, holdFacts, "2026-11-22");
    expect(d).toEqual({ signal: "PAUSE", basis: { ...ai, facts: holdFacts } });
  });

  it("first run: NONE by default; no facts keeps the prior facts", () => {
    expect(decideFedPivot(null, holdFacts, "2026-11-22")).toEqual({ signal: "NONE", basis: { source: "default", reason: null, decided_on: null, facts: holdFacts } });
    const withFacts = { ...ai, facts: holdFacts };
    expect(decideFedPivot({ signal: "NONE", basis: withFacts }, null, "2026-11-22").basis.facts).toEqual(holdFacts);
  });
});

it("the FOMC dates match mcp_server's calendar", () => {
  const path = fileURLToPath(new URL("../../mcp_server/src/lib/economicCalendar.ts", import.meta.url));
  const text = readFileSync(path, "utf8");
  const block = text.slice(text.indexOf("const FOMC_MEETINGS"), text.indexOf("];", text.indexOf("const FOMC_MEETINGS")));
  const dates = [...block.matchAll(/date: "(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
  expect(dates).toEqual([...FOMC_DECISION_DATES]);
});
