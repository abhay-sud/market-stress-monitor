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

## Later: lightweight MCP mode

After Tier 1, about one session: the same replay code behind a small MCP
server, so Claude Desktop or Claude Code can ask for the current reading with
only a FRED key, no Supabase. Its value is discovery through MCP directories.
Build it only once Tier 1 is live.

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

About 4 sessions in total. The lightweight MCP mode (later) is about 1 more.

## Decisions (2026-11-21)

1. **Copy path:** offer both, fork first; private template copy recommended
   for anyone adding `MY_PLAN`. Reason: forks are visible adoption and get
   upstream updates; the private copy covers privacy and the 60-day pause.
2. **Daily brief:** on by default, switchable to weekly or off (`BRIEF`).
3. **AI brief:** in v1, off by default, any provider (Anthropic, Gemini,
   OpenAI-compatible), number check enforced in code.
4. **Fed pivot:** repository variable `FED_PIVOT`, default NONE, shown as
   "not tracked"; copies never read marketstress.org.
