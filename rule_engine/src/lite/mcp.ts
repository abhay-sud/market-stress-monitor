// Lightweight MCP mode ("Ask Claude about your plan"): a small, read-only
// stdio MCP server started by the reader's own MCP client. Market data comes
// straight from FRED (the reader's key), Yahoo and Treasury, replayed through
// the same rules as the live site; the plan and portfolio come from the
// reader's local files. Nothing is written except the history cache.
//
//   claude mcp add market-stress -e FRED_API_KEY=... -- npx tsx <repo>/rule_engine/src/lite/mcp.ts
//
// Settings (environment): FRED_API_KEY (required for market data),
// FED_PIVOT=NONE|PAUSE|CUT, MSM_PLAN_PATH, MSM_PORTFOLIO_PATH, MSM_CACHE_PATH.
// Spec: reference_docs/BUILD_SPEC_run_your_own.md "Lightweight MCP mode".
//
// stdout carries the protocol: log only with console.error, and never log
// tool results, file contents or amounts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchLiteHistory } from "./fetch.js";
import { replay, type DayState } from "./replay.js";
import { fedPivotSetting } from "./decide.js";
import { historyCache, DEFAULT_CACHE_PATH } from "./historyCache.js";
import { loadMyPlan, loadMyPortfolio } from "./myFiles.js";
import { changes, myPlan, pickDay, portfolioDrift, reading, type DataMeta } from "./mcpTools.js";
import { findSection, parseSections, readRulesDoc, tableOfContents } from "./rulesDoc.js";

// The lite fetchers warn with console.warn, which Node writes to stderr: safe for stdio.
const REPLAY_YEARS = 2;

const server = new McpServer({ name: "market-stress", version: "1.0.0" });

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const cache = historyCache({
  fetch: (from) => {
    const key = process.env.FRED_API_KEY?.trim();
    if (!key) throw new Error("FRED_API_KEY is not set");
    return fetchLiteHistory(key, from);
  },
  now: () => new Date(),
  path: process.env.MSM_CACHE_PATH?.trim() || DEFAULT_CACHE_PATH,
  fromDate: (now) => new Date(now.getTime() - REPLAY_YEARS * 365.25 * 86_400_000).toISOString().slice(0, 10),
});

const NO_KEY =
  "Market data needs a free FRED API key (https://fred.stlouisfed.org/docs/api/api_key.html). " +
  "Add FRED_API_KEY to this server's environment in your MCP client config, then restart the client.";

/** Fetches (or reuses) the history and replays it. Throws with a message meant for the reader. */
async function replayed(): Promise<{ days: DayState[]; meta: DataMeta; fedPivotSet: boolean }> {
  if (!process.env.FRED_API_KEY?.trim()) throw new Error(NO_KEY);
  const fed = fedPivotSetting(process.env.FED_PIVOT);
  const h = await cache.get();
  const days = replay(h.history, { from: h.from, fedPivot: fed.value });
  if (days.length === 0) throw new Error("No days to replay: a data source returned nothing. Try again later.");
  console.error(`replayed ${days.length} days to ${days[days.length - 1].date}${h.stale ? " (stale cache)" : ""}`);
  return {
    days,
    meta: { fetched_at: h.fetched_at, stale: h.stale, ...(h.stale_reason ? { stale_reason: h.stale_reason } : {}), sources: h.history.sources },
    fedPivotSet: fed.set,
  };
}

/** Runs a handler; a thrown error becomes a readable tool error instead of a protocol failure. */
function safe<A>(name: string, fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return json(await fn(args));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${name}: ${message.split("\n")[0]}`);
      return { ...json({ error: message }), isError: true };
    }
  };
}

const NOT_ADVICE = "Numbers are computed by code, not by the model; quote them as given. Not investment advice.";

server.registerTool(
  "get_reading",
  {
    description:
      "Today's market-stress reading from the same rules as marketstress.org: the six-indicator panel " +
      "(VIX, high-yield spread, S&P 500 drawdown, 10-year Treasury, Sahm rule, Fed pivot) with colour, " +
      "confirmation and distance to RED; the stress gate; the drawdown risk band; the S&P's high, " +
      "drawdown, episode trough and days since a one-year low; stale series. `summary` is a ready " +
      "plain-text brief. Optional `date` (YYYY-MM-DD) for any day in the last two years. " + NOT_ADVICE,
    inputSchema: { date: z.string().optional() },
  },
  safe("get_reading", async ({ date }: { date?: string }) => {
    const r = await replayed();
    const d = pickDay(r.days, date);
    if ("error" in d) return d;
    return reading(d, r.meta, { fedPivotSet: r.fedPivotSet });
  }),
);

server.registerTool(
  "get_changes",
  {
    description:
      "What changed over the last `days` trading days (default 5, max 60): indicators entering or " +
      "leaving confirmed RED, the stress gate, the drawdown risk band, the S&P crossing 10% or 20% below " +
      "its high, recovery, stale data, and (if the reader has my_plan.yaml) their own wave triggers " +
      "being hit. " + NOT_ADVICE,
    inputSchema: { days: z.number().int().min(1).max(60).optional() },
  },
  safe("get_changes", async ({ days }: { days?: number }) => {
    const r = await replayed();
    const plan = loadMyPlan();
    return {
      ...changes(r.days, days ?? 5, plan.ok ? plan.value : null, r.meta),
      ...(plan.ok ? {} : { your_plan: plan.missing ? "No my_plan.yaml, so your own wave alerts aren't included." : plan.message }),
    };
  }),
);

server.registerTool(
  "get_my_plan",
  {
    description:
      "The reader's own crash deployment plan (local my_plan.yaml) against today's market: which waves " +
      "are armed and since when, how far each wave's fast-panic and slow-bear triggers are, which " +
      "waves are executed, and the amounts to deploy now (cumulative over every armed wave not yet " +
      "executed; in dollars only if the file has cash_reserve_usd). The triggers and amounts are the " +
      "reader's own; never present them as advice. " + NOT_ADVICE,
    inputSchema: {},
  },
  safe("get_my_plan", async () => {
    const plan = loadMyPlan();
    if (!plan.ok) return { setup_needed: plan.message };
    const r = await replayed();
    return myPlan(r.days, plan.value, r.meta);
  }),
);

server.registerTool(
  "get_portfolio_drift",
  {
    description:
      "How far each holding in the reader's local my_portfolio.yaml is from its target, per account, " +
      "flagged by the 5/25 rule (DRIFTED when further than the smaller of 5 points or 25% of the " +
      "target, never under 2 points). Percentages only. " + NOT_ADVICE,
    inputSchema: {},
  },
  safe("get_portfolio_drift", async () => {
    const p = loadMyPortfolio();
    if (!p.ok) return { setup_needed: p.message };
    return portfolioDrift(p.value);
  }),
);

server.registerTool(
  "get_rules",
  {
    description:
      "The rules document behind the reading (crash-check-rules.md), one section at a time: bands, " +
      "confirmation, the stress gate, the drawdown risk band, wave pathways, recovery. No `section`: the " +
      "list of sections with sizes. With `section`: that section (case-insensitive, partial names work).",
    inputSchema: { section: z.string().optional() },
  },
  safe("get_rules", async ({ section }: { section?: string }) => {
    const sections = parseSections(readRulesDoc());
    if (!section) return { sections: tableOfContents(sections) };
    const r = findSection(sections, section);
    if ("found" in r) return { title: r.found.title, ...(r.found.parent ? { within: r.found.parent } : {}), content: r.found.content };
    const candidates = "ambiguous" in r ? r.ambiguous.map((x) => x.title) : tableOfContents(sections).map((t) => t.title);
    return { error: "ambiguous" in r ? `"${section}" matches several sections; ask for one.` : `No section matches "${section}".`, candidates };
  }),
);

server.registerPrompt(
  "check_my_plan",
  {
    title: "Check my plan",
    description: "Today's market reading, your own wave plan and your portfolio drift, explained in plain language.",
  },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            "Check my plan against today's market. Call get_reading, get_my_plan and get_portfolio_drift " +
            "(and get_changes for the last 5 trading days). Then explain in plain language: the market " +
            "reading and what changed; which of my waves is armed, how close the others are, and what my " +
            "plan says to deploy now; and any holding that has drifted. Quote the numbers exactly as the " +
            "tools give them and don't recalculate anything. If a tool says setup is needed, tell me what " +
            "to do. This is my own plan, not advice: don't add buy or sell recommendations.",
        },
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("market-stress MCP server ready (read-only)");
