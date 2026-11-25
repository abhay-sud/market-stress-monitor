// "Run your own" (Tier 1) data fetch: the six panel inputs straight from
// their public sources, no database. Small copies of the ingestion logic
// (ingestion/src/sources/yahoo.ts and fred.ts), because the packages stay
// independent.
//
// S&P 500 and VIX: Yahoo's chart API (no key, same-day closes, completed
// sessions only), FRED as the fallback. The full S&P history is fetched so
// the all-time high is the real one. HY spread, 10-year yield and the Sahm
// rule: FRED, with the 10-year's newest days filled from Treasury.

import type { Point } from "../sp500History.js";

export type { Point };

export interface LiteHistory {
  sp500: Point[];
  vix: Point[];
  hy_spread_pct: Point[];
  treasury_10y: Point[];
  sahm_rule: Point[];
  /** Fed target rate, upper end; empty if FRED failed (the data floor is then off). */
  fed_target: Point[];
  /** Which source each series came from, for the run log. */
  sources: Record<string, string>;
}

const RETRY_DELAYS_MS = [500, 1500, 4000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url: string, headers: Record<string, string> = {}): Promise<Response> {
  let lastError: Error = new Error("unreachable");
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok || res.status < 500) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
  }
  throw lastError;
}

interface YahooChart {
  chart: {
    result?: {
      meta?: { currentTradingPeriod?: { regular?: { start: number; end: number } } };
      timestamp?: number[];
      indicators: { quote: { close: (number | null)[] }[] };
    }[];
    error?: { description: string } | null;
  };
}

// VIX's official close prints at 4:15pm ET; wait a little past the session end.
const CLOSE_SETTLE_SECONDS = 30 * 60;

/** Daily closes from Yahoo, completed sessions only (an in-progress bar is dropped). */
export function parseYahooCloses(body: YahooChart, nowSeconds: number): Point[] {
  if (body.chart.error) throw new Error(`Yahoo error: ${body.chart.error.description}`);
  const result = body.chart.result?.[0];
  if (!result?.timestamp) throw new Error("Yahoo returned no data");
  const session = result.meta?.currentTradingPeriod?.regular;
  if (!session) throw new Error("Yahoo response has no trading period; can't tell a close from an intraday bar");
  const sessionOpen = nowSeconds < session.end + CLOSE_SETTLE_SECONDS;
  const closes = result.indicators.quote[0]?.close ?? [];
  const out: Point[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const close = closes[i];
    if (close === null || close === undefined) continue;
    if (sessionOpen && result.timestamp[i] >= session.start) continue;
    // Yahoo's daily US bars are stamped in the early UTC morning of the trading date.
    out.push({ date: new Date(result.timestamp[i] * 1000).toISOString().slice(0, 10), value: close });
  }
  return out;
}

async function yahooDaily(symbol: string, fromDate: string): Promise<Point[]> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const period1 = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${nowSeconds}&interval=1d`;
  // Yahoo rejects default fetch user agents on this unofficial endpoint.
  const res = await fetchWithRetry(url, { "User-Agent": "Mozilla/5.0" });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  return parseYahooCloses((await res.json()) as YahooChart, nowSeconds);
}

async function fred(seriesId: string, fromDate: string, apiKey: string): Promise<Point[]> {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("observation_start", fromDate);
  const res = await fetchWithRetry(url.toString());
  // Never include the URL in errors: it carries the API key.
  if (!res.ok) {
    // The series ids are fixed, so a 400/403 almost always means the key.
    const hint = res.status === 400 || res.status === 403 ? " (FRED rejected the request: check that FRED_API_KEY is your 32-character key)" : "";
    throw new Error(`FRED ${seriesId}: HTTP ${res.status}${hint}`);
  }
  const body = (await res.json()) as { observations?: { date: string; value: string }[] };
  return (body.observations ?? []).filter((o) => o.value !== ".").map((o) => ({ date: o.date, value: Number(o.value) }));
}

// Daily Treasury Par Yield Curve: the source of FRED's DGS10. Treasury posts
// each day's curve that afternoon; FRED gets it a business day or more later.
// Used only to FILL dates FRED hasn't posted yet (FRED stays authoritative),
// exactly as the live ingest does (ingestion/src/sources/treasury.ts and
// fred.ts; copied, since the packages stay independent).
const CURVE_URL = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all";

/** The "10 Yr" column of one month's par-curve CSV, as points. */
export function parseTreasury10y(text: string): Point[] {
  if (text.trim() === "") return []; // a month with no trading days yet comes back empty
  const lines = text.trim().split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((h) => h.replace(/"/g, "").trim());
  const dateCol = header.indexOf("Date");
  const tenCol = header.indexOf("10 Yr");
  if (dateCol < 0 || tenCol < 0) throw new Error("Treasury curve CSV is missing the Date or 10 Yr column");
  const out: Point[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((c) => c.replace(/"/g, "").trim());
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(cells[dateCol] ?? "");
    const value = Number(cells[tenCol]);
    if (m && cells[tenCol] !== "" && Number.isFinite(value)) out.push({ date: `${m[3]}-${m[1]}-${m[2]}`, value });
  }
  return out;
}

async function treasury10y(now: Date = new Date()): Promise<Point[]> {
  const out: Point[] = [];
  for (const back of [1, 0]) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const month = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const res = await fetchWithRetry(`${CURVE_URL}/${month}?type=daily_treasury_yield_curve&field_tdr_date_value_month=${month}&page&_format=csv`);
    if (!res.ok) throw new Error(`Treasury curve ${month}: HTTP ${res.status}`);
    out.push(...parseTreasury10y(await res.text()));
  }
  return out;
}

/** FRED's points plus Treasury's for dates after FRED's latest. */
export function fillAfter(fredPoints: Point[], fill: Point[]): Point[] {
  const last = fredPoints.reduce((m, p) => (p.date > m ? p.date : m), "");
  return [...fredPoints, ...fill.filter((p) => p.date > last)].sort((a, b) => a.date.localeCompare(b.date));
}

async function withFallback(
  name: string,
  primary: () => Promise<Point[]>,
  fallback: () => Promise<Point[]>,
  sources: Record<string, string>,
  labels: [string, string],
): Promise<Point[]> {
  try {
    const pts = await primary();
    if (pts.length === 0) throw new Error("no data");
    sources[name] = labels[0];
    return pts;
  } catch (err) {
    console.warn(`${name}: ${labels[0]} failed (${err instanceof Error ? err.message : String(err)}); using ${labels[1]}`);
    sources[name] = labels[1];
    return fallback();
  }
}

/** Fetches everything the replay needs. `fromDate` bounds every series except the S&P (full history, for the true all-time high). */
export async function fetchLiteHistory(fredApiKey: string, fromDate: string): Promise<LiteHistory> {
  const sources: Record<string, string> = {};
  const [sp500, vix, hy, dgs10, sahm] = await Promise.all([
    withFallback("sp500", () => yahooDaily("^GSPC", "1927-12-30"), () => fred("SP500", "1900-01-01", fredApiKey), sources, ["Yahoo ^GSPC", "FRED SP500 (10-year window)"]),
    withFallback("vix", () => yahooDaily("^VIX", fromDate), () => fred("VIXCLS", fromDate, fredApiKey), sources, ["Yahoo ^VIX", "FRED VIXCLS"]),
    fred("BAMLH0A0HYM2", fromDate, fredApiKey),
    fred("DGS10", fromDate, fredApiKey),
    fred("SAHMREALTIME", fromDate, fredApiKey),
  ]);
  sources.hy_spread = "FRED BAMLH0A0HYM2";
  let dgs10Filled = dgs10;
  try {
    dgs10Filled = fillAfter(dgs10, await treasury10y());
    const added = dgs10Filled.length - dgs10.length;
    sources.treasury_10y = added ? `FRED DGS10 + Treasury (${added} newer day${added > 1 ? "s" : ""})` : "FRED DGS10";
  } catch (err) {
    console.warn(`treasury_10y: Treasury fill skipped, FRED only (${err instanceof Error ? err.message : String(err)})`);
    sources.treasury_10y = "FRED DGS10";
  }
  sources.sahm_rule = "FRED SAHMREALTIME";
  // Best-effort: without it the Fed pivot falls back to the FED_PIVOT setting.
  let fedTarget: Point[] = [];
  try {
    const since = new Date(Date.parse(fromDate) - 400 * 86_400_000).toISOString().slice(0, 10);
    fedTarget = await fred("DFEDTARU", since, fredApiKey);
    sources.fed_target = "FRED DFEDTARU";
  } catch (err) {
    console.warn(`fed_target: FRED DFEDTARU failed (${err instanceof Error ? err.message : String(err)}); Fed pivot from FED_PIVOT only`);
    sources.fed_target = "unavailable";
  }
  return { sp500, vix, hy_spread_pct: hy, treasury_10y: dgs10Filled, sahm_rule: sahm, fed_target: fedTarget, sources };
}
