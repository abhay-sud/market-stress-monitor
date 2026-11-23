// Lightweight MCP mode: the reader's two optional local files.
//   my_plan.yaml       wave triggers (the MY_PLAN format), optional reserve,
//                      wave splits and executed dates
//   my_portfolio.yaml  holdings and targets per account, in percent
// Default location: local_state/ in this repo (gitignored), or the paths in
// MSM_PLAN_PATH / MSM_PORTFOLIO_PATH. Errors name the key, never echo a value.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { parsePlan, type WaveTriggers } from "./plan.js";
import type { WaveDef } from "./money.js";

export type Wave = "WAVE_1" | "WAVE_2" | "WAVE_3";
export const WAVES: Wave[] = ["WAVE_1", "WAVE_2", "WAVE_3"];

const LOCAL_STATE = fileURLToPath(new URL("../../../local_state/", import.meta.url));

export function planPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MSM_PLAN_PATH?.trim() || `${LOCAL_STATE}my_plan.yaml`;
}

export function portfolioPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MSM_PORTFOLIO_PATH?.trim() || `${LOCAL_STATE}my_portfolio.yaml`;
}

export interface MyPlan {
  wave_triggers: WaveTriggers;
  cash_reserve_usd: number | null;
  waves: Partial<Record<Wave, WaveDef>> | null;
  executed: Partial<Record<Wave, string>>;
}

export interface MyPortfolio {
  accounts: { name: string; holdings_pct: Record<string, number>; target_pct: Record<string, number> }[];
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function readYaml(path: string, label: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = load(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(`${label} is not valid YAML`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${label} must be a YAML mapping`);
  return doc as Record<string, unknown>;
}

/** Parses my_plan.yaml's contents (already loaded). Exported for tests. */
export function parseMyPlan(root: Record<string, unknown>): MyPlan {
  if (!root.wave_triggers) throw new Error("my_plan.yaml needs a wave_triggers block (the same format as MY_PLAN)");
  let triggers: WaveTriggers;
  try {
    triggers = parsePlan(JSON.stringify({ wave_triggers: root.wave_triggers }));
  } catch (err) {
    throw new Error(String(err instanceof Error ? err.message : err).replace(/^MY_PLAN is invalid/, "my_plan.yaml's wave_triggers are invalid"));
  }
  const problems: string[] = [];

  let reserve: number | null = null;
  if (root.cash_reserve_usd !== undefined && root.cash_reserve_usd !== null) {
    if (num(root.cash_reserve_usd) && root.cash_reserve_usd >= 0) reserve = root.cash_reserve_usd;
    else problems.push("cash_reserve_usd must be a number of 0 or more");
  }

  let waves: MyPlan["waves"] = null;
  if (root.waves !== undefined && root.waves !== null) {
    waves = {};
    const raw = root.waves as Record<string, any>;
    for (const w of WAVES) {
      const def = raw[w];
      if (def === undefined) continue;
      if (!def || !num(def.pct_of_reserve) || def.pct_of_reserve < 0 || def.pct_of_reserve > 100) {
        problems.push(`waves.${w}.pct_of_reserve must be a number from 0 to 100`);
        continue;
      }
      if (!Array.isArray(def.splits) || def.splits.length === 0) {
        problems.push(`waves.${w}.splits must be a list of { name, pct_of_wave }`);
        continue;
      }
      const splits = def.splits.map((s: any, i: number) => {
        if (!s || typeof s.name !== "string" || !s.name.trim() || !num(s.pct_of_wave)) problems.push(`waves.${w}.splits[${i}] needs a name and a numeric pct_of_wave`);
        return { name: String(s?.name ?? ""), pct_of_wave: Number(s?.pct_of_wave) };
      });
      const sum = splits.reduce((a: number, s: { pct_of_wave: number }) => a + s.pct_of_wave, 0);
      if (Math.abs(sum - 100) > 0.5) problems.push(`waves.${w}.splits' pct_of_wave values must add up to 100`);
      waves[w] = { pct_of_reserve: def.pct_of_reserve, splits };
    }
    const total = WAVES.reduce((a, w) => a + (waves![w]?.pct_of_reserve ?? 0), 0);
    if (total > 100) problems.push("the waves' pct_of_reserve values add up to more than 100");
  }

  const executed: MyPlan["executed"] = {};
  if (root.executed !== undefined && root.executed !== null) {
    const raw = root.executed as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (!WAVES.includes(k as Wave)) problems.push(`executed.${k} is not WAVE_1, WAVE_2 or WAVE_3`);
      else if (v === null || v === false) continue;
      // js-yaml reads an unquoted 2026-11-24 as a Date.
      else if (v instanceof Date) executed[k as Wave] = v.toISOString().slice(0, 10);
      else if (isDate(v)) executed[k as Wave] = v as string;
      else problems.push(`executed.${k} must be a date (YYYY-MM-DD)`);
    }
  }

  if (problems.length) throw new Error(`my_plan.yaml is invalid: ${problems.join("; ")}`);
  return { wave_triggers: triggers, cash_reserve_usd: reserve, waves, executed };
}

/** Parses my_portfolio.yaml's contents (already loaded). Exported for tests. */
export function parseMyPortfolio(root: Record<string, unknown>): MyPortfolio {
  const raw = root.accounts as Record<string, any> | undefined;
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) throw new Error("my_portfolio.yaml needs an accounts block with at least one account");
  const problems: string[] = [];
  const accounts: MyPortfolio["accounts"] = [];
  const pctMap = (m: unknown, where: string): Record<string, number> => {
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      problems.push(`${where} must be a mapping of holding: percent`);
      return {};
    }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (num(v) && v >= 0 && v <= 100) out[k] = v;
      else problems.push(`${where}.${k} must be a percent from 0 to 100`);
    }
    return out;
  };
  for (const [name, acct] of Object.entries(raw)) {
    accounts.push({ name, holdings_pct: pctMap(acct?.holdings_pct, `accounts.${name}.holdings_pct`), target_pct: pctMap(acct?.target_pct, `accounts.${name}.target_pct`) });
  }
  if (problems.length) throw new Error(`my_portfolio.yaml is invalid: ${problems.join("; ")}`);
  return { accounts };
}

export type Loaded<T> = { ok: true; value: T } | { ok: false; missing: boolean; message: string };

function loadFile<T>(path: string, label: string, example: string, parse: (r: Record<string, unknown>) => T): Loaded<T> {
  if (!existsSync(path)) {
    return {
      ok: false,
      missing: true,
      message: `No ${label} found. Copy local_state/${example} to local_state/${label} and edit it, or set ${label === "my_plan.yaml" ? "MSM_PLAN_PATH" : "MSM_PORTFOLIO_PATH"} to its path. See docs/run-your-own.md.`,
    };
  }
  try {
    return { ok: true, value: parse(readYaml(path, label)) };
  } catch (err) {
    return { ok: false, missing: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export const loadMyPlan = (env: NodeJS.ProcessEnv = process.env) => loadFile(planPath(env), "my_plan.yaml", "my_plan.example.yaml", parseMyPlan);
export const loadMyPortfolio = (env: NodeJS.ProcessEnv = process.env) => loadFile(portfolioPath(env), "my_portfolio.yaml", "my_portfolio.example.yaml", parseMyPortfolio);
