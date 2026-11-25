import type { DataPoint } from "../lib/supabase.js";

// Japan and Germany 10-year government bond yields, added 2026-11-25 for the
// Macro tab's "Global bonds" card (crash-check-rules.md "Global bonds").
// Context only: the M1 backtest (market-hazard-model experiments/
// m1_bond_stress, 2003-2026) found that neither the Japan 10-year's 20-day
// change nor the US-vs-Germany gap improves on drawdown + VIX at 21 or 63
// days, so neither feeds any rule. Shown because Japan is the largest
// foreign holder of Treasuries and Germany tells a US-only yield move apart
// from a global one. Both sources are official, free and keyless; optional
// in ingest.ts, so an outage or format change logs a warning, never fails
// the run. Dollar/yen and euro/dollar come from FRED (DEXJPUS, DEXUSEU).
//
// Japan: Ministry of Finance JGB curve, daily from 1974 (10-year from
// 1986-07). Two CSVs: the current month, and everything before it (updated
// monthly), so the daily run reads both to cover a month change.
// Germany: Bundesbank term-structure yield on listed Federal securities,
// 10.0 years residual maturity, daily from 1997-08 (weekends listed as ".").
const MOF_CURRENT = "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv";
const MOF_HISTORY = "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv";
const BUBA_CODE = "BBSIS.D.I.ZAR.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A";
const BUBA_URL = `https://api.statistiken.bundesbank.de/rest/data/BBSIS/${BUBA_CODE.slice(6)}?format=csv&lang=en`;
// MoF's site has refused requests without a browser-like user agent.
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; market-stress-monitor)" };

async function getText(url: string, label: string): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.text();
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`${label} fetch failed: ${last}`);
}

function point(series_id: string, source: string, code: string, date: string, value: number): DataPoint {
  return { series_id, source, source_series_code: code, observation_date: date, value, unit: "percent", raw_payload: { date, value } };
}

/** MoF CSV: a title line, then "Date,1Y,...,10Y,..." and rows like "2026/11/24,1.63,...". */
export function parseMofJgbCsv(text: string): DataPoint[] {
  const lines = text.split(/\r?\n/);
  const hi = lines.findIndex((l) => l.startsWith("Date,"));
  const col = hi < 0 ? -1 : lines[hi].split(",").indexOf("10Y");
  if (col < 0) throw new Error("MoF JGB CSV has no Date/10Y header");
  const out: DataPoint[] = [];
  for (const line of lines.slice(hi + 1)) {
    const c = line.split(",");
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(c[0] ?? "");
    const v = Number(c[col]);
    if (!m || c[col] === "-" || c[col] === "" || !Number.isFinite(v)) continue;
    const date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    out.push(point("JGB10", "MOF_JAPAN", "jgbcme 10Y", date, v));
  }
  return out;
}

/** Bundesbank CSV: metadata lines, then "YYYY-MM-DD,value,flag"; "." = no value. */
export function parseBundesbankCsv(text: string): DataPoint[] {
  const out: DataPoint[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const c = line.split(",");
    const v = Number(c[1]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c[0] ?? "") || c[1] === "." || c[1] === "" || !Number.isFinite(v)) continue;
    out.push(point("BUND10", "BUNDESBANK", BUBA_CODE, c[0], v));
  }
  return out;
}

function dedupeSorted(points: DataPoint[]): DataPoint[] {
  const m = new Map(points.map((p) => [p.observation_date, p]));
  return [...m.values()].sort((a, b) => a.observation_date.localeCompare(b.observation_date));
}

async function jgb(history: boolean): Promise<DataPoint[]> {
  const texts = await Promise.all([...(history ? [getText(MOF_HISTORY, "MoF JGB history")] : []), getText(MOF_CURRENT, "MoF JGB current month")]);
  let pts = texts.flatMap(parseMofJgbCsv);
  // Early in a month the current file can be empty; the history file has the rest.
  if (!history && pts.length < 10) pts = [...parseMofJgbCsv(await getText(MOF_HISTORY, "MoF JGB history")).slice(-30), ...pts];
  pts = dedupeSorted(pts);
  if (pts.length === 0) throw new Error("MoF JGB CSV parsed to zero rows");
  return pts;
}

async function bund(startPeriod?: string): Promise<DataPoint[]> {
  const pts = parseBundesbankCsv(await getText(startPeriod ? `${BUBA_URL}&startPeriod=${startPeriod}` : BUBA_URL, "Bundesbank 10-year yield"));
  if (pts.length === 0) throw new Error("Bundesbank CSV parsed to zero rows");
  return pts;
}

/** Daily ingest: the trailing few weeks of both, so a late day is picked up next run. */
export async function fetchGlobalRates(): Promise<DataPoint[]> {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 45);
  const results = await Promise.allSettled([jgb(false), bund(start.toISOString().slice(0, 10))]);
  const points = results.flatMap((r) => (r.status === "fulfilled" ? r.value.slice(-25) : []));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length === results.length) throw new Error(failed.map((f) => String(f.reason?.message ?? f.reason)).join("; "));
  for (const f of failed) console.warn(`  Global rates: one source skipped: ${f.reason?.message ?? f.reason}`);
  return points;
}

/** Full history: Japan 10-year from 1986, Germany from 1997 (~17,000 rows). */
export async function fetchGlobalRatesBackfill(): Promise<DataPoint[]> {
  const [j, b] = await Promise.all([jgb(true), bund()]);
  console.log(`  Global rates backfill: JGB10 ${j.length} since ${j[0]?.observation_date}, BUND10 ${b.length} since ${b[0]?.observation_date}`);
  return [...j, ...b];
}
