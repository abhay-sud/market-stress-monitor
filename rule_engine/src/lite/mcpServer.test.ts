// End to end: the real stdio server, driven by an MCP client, on the example
// files. The cache is seeded from the real-history fixture and marked fresh,
// so no network is used. Checks every tool answers and that the server's log
// (stderr) never carries an amount or a holding from the reader's files.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadLiteHistoryFixture } from "./testFixtures.js";

const engine = fileURLToPath(new URL("../../", import.meta.url));
const localState = fileURLToPath(new URL("../../../local_state/", import.meta.url));
const history = loadLiteHistoryFixture();

let client: Client;
let stderr = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "msm-mcp-"));
  writeFileSync(join(dir, "cache.json"), JSON.stringify({ version: 1, fetched_at: new Date().toISOString(), from: "2025-09-01", history: { ...history, sources: { sp500: "fixture" } } }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(engine, "node_modules/tsx/dist/cli.mjs"), "src/lite/mcp.ts"],
    cwd: engine,
    env: {
      ...(process.env as Record<string, string>),
      FRED_API_KEY: "unused-the-cache-is-fresh", // leak-guard: allow (a placeholder, not a key)
      FED_PIVOT: "",
      MSM_CACHE_PATH: join(dir, "cache.json"),
      MSM_PLAN_PATH: join(localState, "my_plan.example.yaml"),
      MSM_PORTFOLIO_PATH: join(localState, "my_portfolio.example.yaml"),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (c) => (stderr += String(c)));
  client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, body: JSON.parse((r.content as { text: string }[])[0].text) };
}

describe("lightweight MCP server", () => {
  it("lists the five tools and the prompt", async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["get_changes", "get_my_plan", "get_portfolio_drift", "get_reading", "get_rules"]);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["check_my_plan"]);
  });

  it("every tool answers from the cache, and the log has no amounts or holdings", async () => {
    const reading = await call("get_reading");
    expect(reading.isError).toBe(false);
    expect(reading.body.as_of).toBe("2026-11-20");
    expect((await call("get_changes", { days: 10 })).isError).toBe(false);
    const plan = await call("get_my_plan");
    expect(plan.body.current_level).toBe("No wave armed");
    expect(plan.body.waves[0].fast_panic.drawdown_points_to_go).toBe(3.4);
    const drift = await call("get_portfolio_drift");
    expect(drift.body.accounts[0].entries[0]).toMatchObject({ holding: "us_total_market", drift_pts: -6, status: "DRIFTED" });
    expect((await call("get_rules", { section: "6-Indicator Panel" })).body.title).toMatch(/6-Indicator Panel/);
    expect((await client.getPrompt({ name: "check_my_plan" })).messages).toHaveLength(1);

    expect(stderr).toMatch(/replayed \d+ days/);
    for (const secret of ["20000", "us_total_market", "international", "retirement", "taxable", "US total market"]) expect(stderr).not.toContain(secret);
  }, 60_000);

  it("a bad date is a readable answer, not a crash", async () => {
    expect((await call("get_reading", { date: "2020-01-01" })).body.error).toMatch(/replay starts on/);
    expect((await call("get_reading", { date: "Nov 20" })).body.error).toMatch(/YYYY-MM-DD/);
  });
});
