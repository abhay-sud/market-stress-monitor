// "Run your own" (Tier 1) entry point, from rule_engine/:
//   npm run lite                 fetch, replay, send what's due, save state
//   npm run lite -- --dry-run    print what would be sent; send and save nothing
//   npm run lite -- --test       send "You're set up" plus today's brief; save nothing
//
// Settings (environment; in GitHub Actions, repository secrets and variables):
//   FRED_API_KEY (required), one notification channel (see notify.ts),
//   BRIEF=daily|weekly|off, FED_PIVOT=NONE|PAUSE|CUT, MY_PLAN (wave triggers, YAML),
//   optional AI paragraph: ANTHROPIC_API_KEY, GEMINI_API_KEY or OPENAI_API_KEY
//   (+ OPENAI_BASE_URL), AI_MODEL (see ai.ts),
//   LITE_STATE_FILE (default .lite-state/state.json; the workflow caches it).
// Spec: reference_docs/BUILD_SPEC_run_your_own.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fetchLiteHistory } from "./fetch.js";
import { replay, type DayState } from "./replay.js";
import { detectEvents, formatBrief } from "./events.js";
import { aiParagraph, aiProviderFromEnv, withAiParagraph, type AiProvider } from "./ai.js";
import { parsePlan } from "./plan.js";
import { channelsFromEnv, sendAll, type Message } from "./notify.js";
import { briefMode, decideRun, EMPTY_STATE, fedPivotSetting, type LiteState } from "./decide.js";

const REPLAY_YEARS = 2;
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const test = args.has("--test");

function loadState(path: string): LiteState {
  if (!existsSync(path)) return EMPTY_STATE;
  try {
    return { ...EMPTY_STATE, ...(JSON.parse(readFileSync(path, "utf-8")) as Partial<LiteState>) };
  } catch {
    console.warn("state file unreadable; starting fresh (alerts only for the latest date)");
    return EMPTY_STATE;
  }
}

export function summarize(d: DayState): string {
  return [
    `As of ${d.date}: ${d.red_count} of 6 RED, ${d.confirmed_red_count} confirmed; stress gate ${d.wave_authorized ? "met" : "not met"}`,
    `drawdown ${d.sp_drawdown_pct.toFixed(1)}%, VIX ${d.inputs.vix.value.toFixed(2)}, risk band ${d.dd_vix_band ?? "not scored"}`,
  ].join("; ");
}

async function main() {
  const channels = channelsFromEnv(process.env);
  if (!dryRun && channels.length === 0) {
    throw new Error("No notification channel is set up. Add NTFY_TOPIC (or Telegram, Discord or Slack secrets); see docs/run-your-own.md.");
  }
  const send = async (m: Message) => {
    const partial = await sendAll(channels, m);
    for (const f of partial) console.warn(`channel failed: ${f}`);
  };

  try {
    const apiKey = process.env.FRED_API_KEY;
    if (!apiKey) throw new Error("FRED_API_KEY is not set (free key: https://fred.stlouisfed.org/docs/api/api_key.html)");
    const fed = fedPivotSetting(process.env.FED_PIVOT);
    const brief = briefMode(process.env.BRIEF);
    const plan = process.env.MY_PLAN?.trim() ? parsePlan(process.env.MY_PLAN) : null;
    const from = new Date(Date.now() - REPLAY_YEARS * 365.25 * 86_400_000).toISOString().slice(0, 10);

    const history = await fetchLiteHistory(apiKey, from);
    console.log(`sources: ${Object.entries(history.sources).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    const days = replay(history, { from, fedPivot: fed.value });
    if (days.length === 0) throw new Error("no days to replay: a data source returned nothing");
    const latest = days[days.length - 1];
    console.log(summarize(latest));
    console.log(`plan: ${plan ? "set" : "not set"}; brief: ${brief}; channels: ${channels.map((c) => c.name).join(", ") || "none"}`);

    // Optional AI paragraph for the brief. A bad AI setting never stops the run.
    let ai: AiProvider | null = null;
    try {
      ai = aiProviderFromEnv(process.env);
    } catch (err) {
      console.warn(`ai: off (${err instanceof Error ? err.message : String(err)})`);
    }
    console.log(`ai: ${ai ? `${ai.name} ${ai.model}` : "off"}`);
    const todaysEvents = detectEvents(days).filter((e) => e.date === latest.date).map((e) => e.title);
    const addAi = async <T extends { title: string; body: string }>(m: T): Promise<T> => {
      if (!ai || !m.title.startsWith("Market stress ·")) return m;
      const r = await aiParagraph(ai, latest, todaysEvents);
      if ("dropped" in r) {
        console.warn(`ai: paragraph dropped, brief sent without it (${r.dropped})`);
        return m;
      }
      console.log("ai: paragraph added");
      return { ...m, body: withAiParagraph(m.body, r.text) };
    };

    if (test) {
      await send({ title: "You're set up", body: "Market stress alerts are working. This is a test; your daily brief and alerts will follow on schedule.", priority: "default" });
      await send(await addAi({ ...formatBrief(latest, { fedPivotSet: fed.set }), priority: "default" as const }));
      console.log("test messages sent");
      return;
    }

    const statePath = process.env.LITE_STATE_FILE || ".lite-state/state.json";
    const state = loadState(statePath);
    const decision = decideRun(days, state, { brief, runDate: new Date().toISOString().slice(0, 10), plan, fedPivotSet: fed.set });
    for (const line of decision.log) console.log(line);
    const messages = await Promise.all(decision.messages.map(addAi));

    if (dryRun) {
      for (const m of messages) {
        // Plan alerts never go to the log: on a public fork it's public.
        console.log(m.personal ? "\n[plan alert: sent to your channels only]" : `\n[${m.priority}] ${m.title}\n${m.body}`);
      }
      console.log(`\n(dry run: ${messages.length} message(s) not sent; state not saved)`);
      return;
    }

    for (const m of messages) await send(m);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(decision.next, null, 2) + "\n");
    console.log(`sent ${messages.length} message(s); state saved`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!dryRun && channels.length) {
      await sendAll(channels, { title: "Market stress run failed", body: `This run failed: ${msg}. The next scheduled run will retry.`, priority: "high" }).catch(() => undefined);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
