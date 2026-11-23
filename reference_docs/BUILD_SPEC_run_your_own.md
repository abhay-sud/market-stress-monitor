# Build spec: "Run your own" (Tier 1, alerts only)

Status: approved approach, not built. Written 2026-11-21; open questions
decided 2026-11-21 (see Decisions at the end).

## Positioning

> Crash-plan alerts for long-term investors. The code makes the call, AI
> explains it.

Borrow the distribution model that made similar "fork it, get daily pushes"
projects grow (five-minute fork setup, free data by default, any LLM, sample
output first), but keep this project's difference: deterministic,
backtested rules with the failures published. Not a stock picker and not a
trading tool: no per-stock analysis, no buy/sell calls, no LLM decisions.

## Goal

Anyone can get their own copy of the stress monitor running in about ten
minutes, with no database, no website and no local software: copy the repo,
add a free FRED key and one notification channel, switch on GitHub Actions.
Every weekday evening they get the six-indicator reading on their phone, plus
alerts when something changes. Optionally they add their own crash
deployment plan as a secret and get private "Wave N trigger hit" alerts.

What it is not: their own dashboard (Tier 2), the Supabase pipeline, the MCP
server or the private report (Tier 3, the current full setup).

The engine is the same code as the live site. Tier 1 reuses the pure rule
functions; nothing about the classification changes.

## User flow

1. **Copy the repo.** Both paths are offered, fork first:
   - **Fork** (the quick way to try it): one click, upstream updates through
     "Sync fork", counts visibly on the upstream repo. Always public.
   - **"Use this template" set to Private** (recommended for anyone adding
     `MY_PLAN`): private logs, no 60-day schedule pause, but no automatic
     updates.
   The README gives this trade-off in two lines; details under Privacy below.
2. **Get a FRED key** (free, about a minute at fred.stlouisfed.org).
3. **Add secrets** (Settings → Secrets and variables → Actions):
   - `FRED_API_KEY` (required)
   - one alert channel (see Notifications)
   - optional `MY_PLAN` (their wave triggers, YAML; see Personal plan)
   - optional AI key for the summary paragraph: `ANTHROPIC_API_KEY`,
     `GEMINI_API_KEY`, or `OPENAI_API_KEY` (+ `OPENAI_BASE_URL` for any
     OpenAI-compatible provider); see Optional AI brief
4. **Run it once**: Actions → "Run your own" → Run workflow, with `test` ticked.
   They receive "You're set up" plus today's reading.
5. Optional: edit `config/monitoring.yaml` to change bands or the gate. It's
   the same file the live engine uses.

## What they receive

### Daily brief (on by default, weekdays after the close)

Repository variable `BRIEF`: `daily` (default), `weekly` (Fridays) or `off`
(event alerts only). Daily is the default because an alerts-only setup stays
silent for months in a calm market and looks broken.

```
Market stress · Thu Nov 19
1 of 6 red: 10Y Treasury 5.04% · 1 amber: VIX 28.4
Stress gate: not met (needs 3 of 6 confirmed RED)
Drawdown risk: HIGH. Since 1994, 44% of High days saw the S&P close
10%+ below its peak within a month (typical day: 12%).
Closest to red: VIX 6.6 pts away · S&P drawdown 11.8 pts away
Not investment advice · marketstress.org
```

### Event alerts (sent whenever they happen, independent of the brief)

| Event | Source of truth |
|---|---|
| An indicator becomes confirmed RED, or leaves RED | `computeConfirmation` streaks, rebuilt by replay |
| Stress gate met / no longer met | `isWaveAuthorized(confirmedRedCount)` |
| Drawdown risk band changes (Low / Elevated / High) | `baselineScore` + `bandBaseline` |
| S&P drawdown crosses 10% or 20% from its high | `drawdownPct` |
| Recovery confirmed after a 10%+ episode | the recovery criteria in `classify.ts` |
| Data stale or run failed | runner health check |

### Personal plan alerts (only with `MY_PLAN`)

"Wave 2 trigger hit (slow bear). Stress gate not met (1 of 6 confirmed RED),
information only." The same wording and re-arm rule as
`mcp_server/src/lib/waveAlert.ts`. The text never includes trigger levels,
amounts or the plan itself.

## Architecture

```
GitHub Actions (weekday cron + manual run)
  └─ rule_engine: npm run lite
       1. fetch   ~2 years of daily closes: S&P 500 and VIX (Yahoo, no key;
                  FRED fallback), HY OAS, 10Y yield, Sahm rule (FRED)
       2. replay  bands, confirmation streaks, drawdown and ATH, days since
                  the 252-day low, trough and recovery, all observation by
                  observation, with the existing pure functions
       3. decide  brief due? which events fired on dates after the last run?
                  wave level (only if MY_PLAN is set)
       4. notify  through every configured channel
       5. save    last processed observation date and alert ledger (cache)
```

### Stateless by replay

The production rule engine carries state forward in the previous
`crash_checks` row. Tier 1 rebuilds that state each run instead, by replaying
the fetched history through the same functions. In the main loop of
`classify()`, each new observation date already counts as one confirmation
step, so a replay over the history gives the same streaks a daily run would
have stored. Consequences:

- No database and no committed data. Nothing personal is ever written to the
  repo.
- A missed day or a late source self-heals on the next run.
- Wave status uses `evaluateWaveHistory` exactly as the local MCP server
  does, over the replayed rows.

The only state kept between runs is small and contains no market or personal
data: the last processed observation date and which alerts were sent for
which dates. It lives in the Actions cache (`actions/cache`, a key per run,
restored from the newest). If the cache is ever evicted, the runner falls
back to "alert only on transitions dated the latest observation", which at
worst skips or repeats one alert.

### Code layout

All in `rule_engine/` (it already owns the rules and the config loader), so
no new package and no root-level install:

| File | Purpose |
|---|---|
| `src/lite/run.ts` | Entry point: `npm run lite [-- --dry-run | --test]` |
| `src/lite/fetch.ts` | Minimal fetchers for the 5 series and S&P/VIX closes. Small copies of the ingestion logic (FRED observations, Yahoo daily closes, S&P ATH), since packages stay independent. |
| `src/lite/replay.ts` | Pure: history → per-date panel states, confirmation, risk band, trough/recovery, days since 252-day low |
| `src/lite/events.ts` | Pure: two consecutive states → list of events; brief formatting |
| `src/lite/plan.ts` | Pure: parse and validate `MY_PLAN`; wave replay via a copy of `evaluateWaveHistory` / `decideWaveAlert` (mcp_server stays independent) |
| `src/lite/notify.ts` | Channels, dependency-free `fetch` calls |
| `src/lite/ai.ts` | Optional AI paragraph: three provider adapters over `fetch`, prompt, number check, fallback |
| `src/lite/*.test.ts` | Vitest: replay matches stored `crash_checks` rows on a fixture; events; plan parsing; message text has no plan numbers |

`rules.ts` and `hazardScorecard.ts` are imported, not copied.

### Notifications

One or more of these, each enabled by its secrets. All are plain HTTPS
calls, with no new dependencies:

| Channel | Secrets |
|---|---|
| ntfy (phone app, free, no account) | `NTFY_TOPIC` (+ optional `NTFY_SERVER`) |
| Email via ntfy's email forwarding | `NTFY_TOPIC` + `ALERT_EMAIL` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Discord | `DISCORD_WEBHOOK_URL` |
| Slack | `SLACK_WEBHOOK_URL` |

### Workflow

`.github/workflows/run-your-own.yml`:

- `schedule`: weekdays 22:30 UTC (after the US close, so same-day S&P and VIX)
  and `workflow_dispatch` with inputs `test` and `dry_run`.
- Runs only when the repository variable `MSM_MODE` is unset or `lite`.
- Steps: checkout, setup-node 22, `npm ci` in `rule_engine`, restore cache,
  `npm run lite`, save cache. About 1–2 minutes per run.

**Mode guard for the existing workflows.** `ingest.yml`, `backfill.yml` and
`sec13f.yml` need Supabase secrets a copy won't have, and would fail every day
and email the owner. They get `if: vars.MSM_MODE == 'full'`; the upstream repo
sets `MSM_MODE=full`, so the live site is unaffected.

### Personal plan (`MY_PLAN` secret)

The `wave_triggers` block of `local_state/policy.example.yaml`, pasted as a
secret:

```yaml
wave_triggers:
  fast_panic:
    WAVE_1: { drawdown_pct_gte: 15, vix_gt: 30 }
    ...
  slow_bear:
    freshness_window_trading_days: 30
    ...
```

Validated at startup. On invalid input it fails with a message that names the
missing key, never echoing the value. Allocation splits are not part of Tier 1.
The alert says which wave, and the user's own plan says what to do.

### Fed pivot signal

Today the Fed pivot indicator is a manual judgment carried forward. In Tier 1
it comes from the repository variable `FED_PIVOT` (the same values the rule
engine accepts), default NONE, and the brief says "Fed pivot: not tracked"
while it is unset. Copies never read marketstress.org: that would tie every
user's alerts to the upstream site's uptime.

### Optional AI brief (in v1, off by default)

If an AI key is set, one paragraph is appended to the daily brief. Providers,
all through plain HTTPS `fetch` with no SDK dependency:

| Provider | Secrets / variables |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| Any OpenAI-compatible endpoint (OpenAI, DeepSeek, Qwen, OpenRouter, a local server) | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |

The model is set by the repository variable `AI_MODEL`, with a sensible
default per provider. The model gets the day's computed state as JSON and is
told to explain it, not to change it. "The LLM never does the numbers" is
enforced in code: every number in the reply must appear in the input, or the
paragraph is dropped and the deterministic brief goes out alone. Any provider
error has the same fallback. The cost is one short call per weekday on the
user's own key.

## Privacy and safety

- **Fork (listed first):** forks of a public repo are public, and so are
  their Actions logs. The plan stays in a secret (GitHub masks secret values
  in logs), the runner never prints plan values or wave levels to the log
  (alert text goes only to the channel), and the README warns that a public
  fork can't hold anything personal in files. Scheduled runs pause after 60
  days without repo activity; GitHub emails first and one click restarts
  them. The README says so plainly.
- **Private template copy (recommended with `MY_PLAN`):** logs are private,
  and GitHub doesn't pause schedules after 60 days (that rule only applies to
  public repos). Private repos get 2,000 free Actions minutes a month; this
  uses about 40.
- **Leak guard:** recommended in the setup doc for anyone who adds personal
  files.
- **Upstream updates:** forks can click "Sync fork". Template copies can't sync
  automatically; the doc gives the two git commands to pull upstream changes.

## Docs and launch

- **README rework** (after Tier 1 works):
  - top: a phone screenshot of a real alert and the marketstress.org link
  - first section: "Run your own", fork first, linking to
    `docs/run-your-own.md` (step by step, with screenshots of the secrets
    page and a sample alert)
  - a short "What we tested and dropped" section: the retired hazard model,
    the regime tilts with no edge, the 2-RED alert that never warned early
  - a support stance: issues for bugs, pull requests welcome with no promise
    to merge, maintained as time allows
  - "Not investment advice", also on every message
- marketstress.org: a small "Get these alerts yourself" link to that doc.
- Repo setting: mark the repo as a template (for the private path).
- **No sponsor or referral links** anywhere, setup included.
- **Launch order:** LICENSE committed (pending the employer check; until then
  nobody may legally run a copy) → Tier 1 built → tested on a fresh fork and a
  fresh private template copy → README rework → one launch: a Show HN post on
  "I backtested my own crash signals", plus r/Bogleheads, r/investing and MCP
  directories, ideally during a market sell-off.

## Lightweight MCP mode ("Ask Claude about your portfolio")

Status: built 2026-11-22. Verified live against FRED and Yahoo, and in a
real Claude Code session; the raw-data parity test, the 2020/2022 wave
replays and the end-to-end server test are in `rule_engine/src/lite/`.
Widened from the original
"current reading only" note: the reason to build it is the private layer
(your plan and your portfolio next to the market reading), not the reading
alone, which the alerts copy already sends.

### Goal

A reader with a free FRED key and two small local files can ask Claude
Desktop or Claude Code "what does my plan say today?" and get the same
reading as the live site, which of their waves is armed and how close the
others are, the amounts their plan would deploy, and how far their
portfolio has drifted from its targets. No Supabase, no Cloudflare, no
GitHub Actions, no server to host.

### How it runs

- A stdio MCP server started by the reader's own MCP client on their own
  machine: `npx tsx rule_engine/src/lite/mcp.ts`. Nothing is hosted.
- Each call needing market data uses the Tier 1 fetch and replay
  (`fetchLiteHistory` → `replay`) directly from the reader's machine: FRED
  with their key, Yahoo and Treasury without one. It never reads the
  upstream Supabase, so readers cost the upstream project nothing and keep
  working if it stops.
- The fetched history is cached on disk (`.lite-state/mcp-history.json`,
  already gitignored) and re-fetched when it's older than the latest settled
  close (the same settle rule as `parseYahooCloses`) or 6 hours, whichever
  comes first. A failed fetch serves the cache with a `stale` flag, or an
  error naming the source.
- **Read-only.** The server writes nothing except that cache: no write
  tools, no state, no telemetry. Outbound calls go only to FRED, Yahoo and
  Treasury.

### Where it lives

`rule_engine/src/lite/mcp.ts` (new), plus `npm run mcp` in `rule_engine`.
The replay, events and wave evaluation are already in `rule_engine/src/lite/`,
so the reader installs one package. `rule_engine` gains two dependencies:
`@modelcontextprotocol/sdk` and `zod`, the same versions as `mcp_server`.

Two small pure functions from `mcp_server` are copied into
`rule_engine/src/lite/money.ts`, each with a comment naming the original:

- `computeWaveDeployment` (`mcp_server/src/lib/waveDeployment.ts`)
- `computePortfolioDrift` and `driftThresholdPts`, the 5/25 rule
  (`mcp_server/src/lib/portfolio.ts`)

There's no cross-package import at run time. A shared fixture
(`config/fixtures/lite-money.json`: inputs plus expected outputs) is checked
by a test in each package, so the copies can't drift silently. AGENTS.md
gets a line for this pair next to the other copies.

### The reader's files

Both are optional and live in `local_state/` by default (already
gitignored), or wherever `MSM_PLAN_PATH` / `MSM_PORTFOLIO_PATH` point.
Generic examples are tracked as `local_state/my_plan.example.yaml` and
`local_state/my_portfolio.example.yaml`, with round illustrative numbers and
no fund names beyond generic ones ("US total market", "Bonds").

`my_plan.yaml` is a superset of the `MY_PLAN` secret, so one file works for
both:

```yaml
wave_triggers:            # required; exactly the MY_PLAN format (parsePlan)
  fast_panic: { ... }
  slow_bear: { ... }
cash_reserve_usd: 20000   # optional; without it, amounts are shown as % only
waves:                    # optional; how each wave splits
  WAVE_1:
    pct_of_reserve: 25
    splits:
      - { name: "US total market", pct_of_wave: 60 }
      - { name: "International", pct_of_wave: 40 }
  WAVE_2: { ... }
  WAVE_3: { ... }
executed:                 # optional; edited by hand after buying
  WAVE_1: "2026-11-24"
```

`my_portfolio.yaml`:

```yaml
accounts:
  main:
    holdings_pct: { us_total_market: 55, international: 25, bonds: 20 }
    target_pct:   { us_total_market: 60, international: 25, bonds: 15 }
```

Validation errors name the key, never echo a value (the same rule as
`parsePlan`).

### Tools

| Tool | Returns | Needs |
|---|---|---|
| `get_reading` | Today's six-indicator panel: value, colour, observation date and confirmation streak per indicator; stress gate; drawdown risk band (or "not scored" past 10%); distance to RED; drawdown, all-time high, trough, days since the 252-day low; stale series; the Fed pivot and its rate facts. Optional `date` for any replayed day. | FRED key |
| `get_changes` | Events over the last N trading days (default 5, max 60), from `detectEvents`: confirmed RED in or out, gate, band, drawdown lines, recovery. | FRED key |
| `get_my_plan` | Per wave: armed or not, which pathway, confirmation progress, distance to its triggers (drawdown points, VIX points), executed or pending. If the reserve and splits are given: the cumulative, execution-aware amounts to deploy now (the same rule as `get_deployment_plan`). | `my_plan.yaml` |
| `get_portfolio_drift` | Per account and holding: actual, target, drift and the 5/25 threshold, ON_TARGET or DRIFTED. | `my_portfolio.yaml` |
| `get_rules` | The table of contents, or one section of `crash-check-rules.md` (copied section lookup; no personal-rules merge). | nothing |

Plus one MCP prompt, `check_my_plan`: call `get_reading`, `get_my_plan` and
`get_portfolio_drift`, then explain in plain language, quote the numbers as
given, and don't recalculate them. That's the one-click entry point in
clients that show prompts.

Each tool description says the numbers are computed by code and are not
investment advice. A tool whose file is missing returns a setup hint
(copy the example, set the path), not an error.

The Fed pivot uses `FED_PIVOT` plus the data floor, exactly as in Tier 1.
There's no AI write-back: the reader's Claude can discuss the Fed in chat,
but it can't set the signal.

### Privacy

- The dollar amounts and holdings are read from local files at call time and
  returned to the reader's own MCP client. **They do go to the reader's AI
  provider as part of the conversation.** The docs say this plainly. A
  reader who wants no dollar figures in chat leaves `cash_reserve_usd` out
  and gets percentages only.
- No logging of tool results, file contents or amounts to stderr; logs carry
  only source names, dates and counts.
- Nothing is written to the repo or sent anywhere except the three data
  sources.

### Setup (docs)

Claude Code:

```
claude mcp add market-stress -e FRED_API_KEY=... -- npx tsx <repo>/rule_engine/src/lite/mcp.ts
```

Claude Desktop: a `claude_desktop_config.json` snippet with the same command,
`cwd` set to `rule_engine`, and the Windows variant (`cmd /c npx ...`). The
docs go in a new section of `docs/run-your-own.md`, "Ask Claude about your
plan", after the alerts setup. The README gets the "Your private layer"
section: this mode first (with a chat mockup from real output on the example
files), and the full setup's Full Report page shown as "the full setup adds".

### Out of scope for this mode

The Full Report page, the watchlist and insider activity, 13F, fund-filing
watch, crash-type diagnosis and its layers, stored history and scorecards,
write tools of any kind, and publishing to npm or an MCP registry (a later,
separate step once it has been used for a while).

### Acceptance criteria

1. With only `FRED_API_KEY`, `get_reading` for a date in the Tier 1 parity
   fixture returns the stored `crash_checks` colours,
   `confirmed_red_count`, `dd_vix_band` and drawdown for that date.
2. `get_my_plan` on the example plan over the 2020 and 2022 fixtures arms
   waves in the same order and on the same dates as `evaluateWaves`; the
   amounts are cumulative and skip executed waves.
3. The shared money fixture passes in both `rule_engine` and `mcp_server`.
4. With no plan or portfolio file, those two tools return a setup hint, and
   the other three still work.
5. A second call within the cache window makes no network request; a fetch
   failure serves the cache flagged `stale`.
6. A test runs every tool on the example files and checks that stderr
   contains no amount or holding from them.
7. `npm run typecheck` and `npm test` pass in `rule_engine` and
   `mcp_server`; the full `mcp_server` is unchanged in behaviour.
8. Manual: connected in Claude Code and Claude Desktop on Windows, the
   `check_my_plan` prompt gives a sensible answer on the example files.

### Effort

About two sessions: (1) the server, the five tools, the cache and the copied
money functions with the shared fixture; (2) the example files, the
remaining tests, the docs section, then the README section and mockups.

## Out of scope

Per-stock analysis or buy/sell calls, a web app, Docker, multiple languages,
and sponsor links. They are what make comparable projects close to a
full-time job, and they would undercut "the code decides". Tier 2 (a user's
own dashboard) waits until people ask for it.

## Acceptance criteria

1. On a fresh fork, and on a fresh private template copy, with only
   `FRED_API_KEY` and `NTFY_TOPIC`, a manual run with `test` delivers the
   setup message and today's reading.
2. Replay over a fixture of 60 real days reproduces the stored
   `crash_checks` colours, `confirmed_red_count`, `wave_authorized` and
   `dd_vix_band` on every date.
3. With `MY_PLAN` set to the example triggers, replaying a 2020 or 2022
   fixture fires each wave alert once, in order, and never repeats it before
   the re-arm rule allows.
4. The upstream repo's scheduled runs are unchanged (`MSM_MODE=full`), and a
   copy without `MSM_MODE` runs only "Run your own".
5. Nothing personal appears in Actions logs: a test greps the log for the
   `MY_PLAN` values.
6. `npm run typecheck` and `npm test` pass in `rule_engine`.
7. With an AI key set, a reply containing a number not in the input is
   dropped and the deterministic brief still goes out; the same happens on a
   provider error. Tested for each of the three provider types with mocked
   responses.
8. `BRIEF=off` sends only event alerts; `FED_PIVOT` unset shows "not
   tracked".

## Effort

| Piece | Estimate |
|---|---|
| Fetchers, replay, parity test against stored rows | 1 session |
| Events, brief, plan alerts, notifiers, tests | 1 session |
| Workflow, mode guard, docs, README, template setting | 0.5–1 session |
| Optional AI brief, three provider types, with the number check | 0.5–1 session |
| README rework | 0.5 session |

About 4 sessions in total. The lightweight MCP mode is about 2 more (see its section).

## Decisions (2026-11-21)

1. **Copy path:** offer both, fork first; private template copy recommended
   for anyone adding `MY_PLAN`. Reason: forks are visible adoption and get
   upstream updates; the private copy covers privacy and the 60-day pause.
2. **Daily brief:** on by default, switchable to weekly or off (`BRIEF`).
3. **AI brief:** in v1, off by default, any provider (Anthropic, Gemini,
   OpenAI-compatible), number check enforced in code.
4. **Fed pivot:** repository variable `FED_PIVOT`, default NONE, shown as
   "not tracked"; copies never read marketstress.org.
