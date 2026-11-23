# Run your own: market stress alerts on your phone

Get the six-indicator market stress reading every weekday evening, plus an
alert when something changes, from your own copy of this repo. It runs on
GitHub Actions for free: no server, no database, nothing to install. Setup
takes about ten minutes.

> [!WARNING]
> **Not investment advice.** The alerts apply this project's rules to public
> data. They are not recommendations, and the data can be delayed or wrong.

## What you get

**A daily brief** after the US close (weekdays):

```
Market stress · Fri Nov 20
1 of 6 RED: VIX 35.89 (not yet confirmed)
3 AMBER: High-yield spread 352 bp (Nov 19) · S&P 500 drawdown 11.6% · 10-year Treasury 4.92%
Stress gate: not met (0 of 6 confirmed RED; the gate needs 3)
Drawdown risk band: not scored, because the S&P 500 is already 11.6% below its high.
Closest to RED: 10-year Treasury 0.08 pts away · S&P 500 drawdown 8.4 pts away
Not investment advice · marketstress.org
```

**Alerts** when something changes:

| Alert | When |
|---|---|
| *Indicator* confirmed RED | An indicator has been RED on two readings in a row, so it counts toward the stress gate |
| *Indicator* no longer RED | A confirmed RED indicator drops back |
| Stress gate met / no longer met | 3 of the 6 indicators are confirmed RED (information only) |
| Drawdown risk rises | The drawdown risk band moves up: Low → Elevated → High |
| S&P 500 *n*% below its high | The S&P crosses 10% or 20% below its all-time high (once per fall) |
| Recovery confirmed | The rules' recovery test passes after a 10%+ fall |
| Data is stale / run failed | A source stopped updating, or a run broke |
| Wave *N* trigger hit | Only if you add your own plan (see below) |

The rules are the same code as [marketstress.org](https://marketstress.org/)
(see [the rules](../reference_docs/rules/crash-check-rules.md)). Your copy
fetches the data itself each evening and rebuilds the state from history, so a
missed day fixes itself on the next run.

## Set it up

### 1. Copy the repo

Pick one:

- **Fork** (quickest): click **Fork** at the top of the repo page. Forks of a
  public repo are public, including their Actions logs. Your secrets stay
  secret, but don't put anything personal in files.
- **Private copy** (recommended if you'll add your own plan): click **Use this
  template → Create a new repository** and choose **Private**. Logs stay
  private and scheduled runs never pause, but you won't get updates with one
  click (see [Updating](#updating)).

### 2. Get a free FRED API key

Sign up at [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html)
(about a minute) and copy the key.

### 3. Choose where alerts go

The simplest is **ntfy**, a free phone app with no account:

1. Install ntfy ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) or [iOS](https://apps.apple.com/app/ntfy/id1625396347)).
2. Make up a long, random topic name, for example `stress-7f3k9q2m8x`.
   Anyone who knows it can read your alerts, so treat it like a password.
3. In the app, subscribe to that topic.

Or use Telegram, Discord, Slack or email instead (or as well); see
[Settings](#settings).

### 4. Add your secrets

In your copy: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Value |
|---|---|
| `FRED_API_KEY` | Your FRED key |
| `NTFY_TOPIC` | Your ntfy topic |

### 5. Turn on Actions and send a test

1. Open the **Actions** tab. On a fork, click **I understand my workflows, go
   ahead and enable them**.
2. Click **Run your own (market stress alerts)** → **Run workflow**, tick
   **Send a 'You're set up' message**, and run it.
3. Within a couple of minutes your phone gets "You're set up" and today's brief.

That's it. From now on it runs every weekday at 22:30 UTC (5:30pm New York
time in winter, 6:30pm in summer).

## Settings

**Secrets** (Settings → Secrets and variables → Actions → *Secrets*):

| Secret | What it does |
|---|---|
| `FRED_API_KEY` | Required |
| `NTFY_TOPIC` | ntfy alerts |
| `ALERT_EMAIL` | Also email every ntfy alert to this address (needs `NTFY_TOPIC`) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Telegram alerts |
| `DISCORD_WEBHOOK_URL` | Discord alerts |
| `SLACK_WEBHOOK_URL` | Slack alerts |
| `MY_PLAN` | Your own wave triggers (see below) |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `OPENAI_API_KEY` | Optional AI summary in the brief (see below) |

**Variables** (same page, *Variables* tab):

| Variable | Values | Default |
|---|---|---|
| `BRIEF` | `daily`, `weekly` (Fridays) or `off` (alerts only) | `daily` |
| `FED_PIVOT` | `NONE`, `PAUSE` or `CUT`: your read of the Fed. The run sets CUT by itself right after a Fed rate cut (from the Fed's target rate on FRED); use this for anything else, such as a signalled cut. Update it when the Fed changes course. | `NONE`, except after a cut |
| `NTFY_SERVER` | Your own ntfy server URL | `https://ntfy.sh` |

To change the bands or the stress gate, edit
[`config/monitoring.yaml`](../config/monitoring.yaml) in your copy. It's the
same file the live site uses.

## Your own plan (optional)

If you keep cash ready to invest in a sell-off in stages ("waves"), you can
get an alert when your own trigger levels are hit. Add a `MY_PLAN` secret with
your triggers, in this shape (the numbers here are only an example):

```yaml
wave_triggers:
  fast_panic:            # a sharp fall: drawdown AND VIX on the same day
    WAVE_1: { drawdown_pct_gte: 15, vix_gt: 30 }
    WAVE_2: { drawdown_pct_gte: 25, vix_gt: 35 }
    WAVE_3: { drawdown_pct_gte: 35, vix_gt: 40 }
  slow_bear:             # a grinding fall: drawdown AND a fresh 1-year low
    freshness_window_trading_days: 30
    WAVE_2: { drawdown_pct_gte: 25 }
    WAVE_3: { drawdown_pct_gte: 35 }
```

The alert says only which wave was hit, for example *"Wave 2 trigger hit
(slow bear)"*. Your levels never appear in an alert or in the Actions log, and
what to do is up to your own plan. An alert fires once when the level rises,
and again only after ten quiet trading days.

## Ask Claude about your plan (optional)

Alerts tell you when something happens. To ask questions in between ("what
does my plan say today?", "how close is Wave 2?", "has my portfolio
drifted?"), run the same engine as a small MCP server for Claude Desktop or
Claude Code (or any other MCP client). It runs on your own computer: it
fetches the data itself with your FRED key, reads your plan and portfolio
from two local files, and nothing is hosted or stored anywhere else.

Here is Claude answering on the [example files](#2-add-your-files), with the
market as of Friday 20 November 2026:

> **Your plan:** No wave is armed, so nothing to deploy now.
> Wave 1 (fast panic): 3.4 drawdown points to go; VIX is already above its
> threshold. Wave 2: 13.4 drawdown points to go on both pathways (slow bear:
> 0 of 2 dates met). Wave 3: 23.4 drawdown points to go, and VIX would need to
> rise 4.11 points.
>
> **Drift:** Retirement: US total market at 54% vs a 60% target (−6 pts,
> DRIFTED), cash at 6% vs a 0% target (+6 pts, DRIFTED); international and
> bonds on target. Taxable: everything on target.

The numbers come from code, not from the model. Claude only explains them.

### What it can answer

| Tool | Answers |
|---|---|
| `get_reading` | Today's reading (or any day in the last two years): the six indicators with colour, confirmation and distance to RED, the stress gate, the drawdown risk band, the S&P's high, drawdown and trough |
| `get_changes` | What changed over the last few trading days, including your own wave triggers |
| `get_my_plan` | Which of your waves is armed and since when, how far each trigger is, and what your plan says to deploy now: every armed wave you haven't marked done, in dollars if you give a cash reserve |
| `get_portfolio_drift` | How far each holding is from its target, flagged by the 5/25 rule |
| `get_rules` | Any section of [the rules](../reference_docs/rules/crash-check-rules.md) |

Plus a ready-made prompt, **check_my_plan**, that runs them together and
explains the result.

### 1. Install

You need [Node.js](https://nodejs.org/) 22 or later and a copy of the repo
on your computer:

```bash
git clone https://github.com/abhay-sud/market-stress-monitor.git
cd market-stress-monitor/rule_engine
npm ci
```

(For a private copy, clone yours instead.)

### 2. Add your files

Both are optional, and both live in `local_state/`, which git ignores:

```bash
cp local_state/my_plan.example.yaml local_state/my_plan.yaml
cp local_state/my_portfolio.example.yaml local_state/my_portfolio.yaml
```

Then edit them.

- **[`my_plan.yaml`](../local_state/my_plan.example.yaml)** holds:
  - your wave triggers, in the same format as the `MY_PLAN` secret, so one file serves both;
  - optionally, your cash reserve and how each wave splits;
  - the dates of waves you've already bought.
- **[`my_portfolio.yaml`](../local_state/my_portfolio.example.yaml)** holds each account's holdings and targets, in percent.

To keep the files somewhere else, set `MSM_PLAN_PATH` and
`MSM_PORTFOLIO_PATH` to their paths.

### 3. Connect it

In the commands below, `REPO` stands for the full path of your copy, for
example `C:/Users/you/market-stress-monitor` or
`/Users/you/market-stress-monitor`.

**Claude Code:**

```bash
claude mcp add market-stress --scope user -e FRED_API_KEY=your-key -- node REPO/rule_engine/node_modules/tsx/dist/cli.mjs REPO/rule_engine/src/lite/mcp.ts
```

**Claude Desktop:** open Settings → Developer → Edit Config and add this to
`claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "market-stress": {
      "command": "node",
      "args": ["REPO/rule_engine/node_modules/tsx/dist/cli.mjs", "REPO/rule_engine/src/lite/mcp.ts"],
      "env": { "FRED_API_KEY": "your-key" }
    }
  }
}
```

Add `"FED_PIVOT": "PAUSE"` (or `CUT`) to `env` for your own read of the Fed,
as with the alerts.

Then ask, for example, *"What does my plan say today?"*. You can also run the
prompt: `/mcp__market-stress__check_my_plan` in Claude Code, or the **+**
menu in Claude Desktop.

### What stays private, and what doesn't

- **Nothing is hosted.** The server runs on your computer and only reads
  your files. It writes one file, a cache of the market data in
  `rule_engine/.lite-state/`, and connects only to FRED, Yahoo Finance and
  the US Treasury.
- **What you ask about goes to your AI provider.** When Claude answers, the
  readings, your trigger levels and any amounts become part of the chat, as
  with anything you type. To keep dollar figures out of it, leave
  `cash_reserve_usd` out of `my_plan.yaml`, and the plan is shown in percent
  only.
- The server's own log carries only dates and counts, never your levels,
  holdings or amounts.

The first question of the day takes a few seconds while it fetches; later
ones answer from the cache, which refreshes after each US close.

## AI summary (optional)

Add one AI key and the daily brief gets a short paragraph on what the
reading adds up to, written by the model you choose:

| Provider | Secret | Variable |
|---|---|---|
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | `AI_MODEL` optional (default `claude-sonnet-5-5`) |
| Google Gemini | `GEMINI_API_KEY` | `AI_MODEL` required (a Gemini model name) |
| Any OpenAI-compatible API (OpenAI, DeepSeek, OpenRouter, a local server...) | `OPENAI_API_KEY` | `AI_MODEL` required; `OPENAI_BASE_URL` for anything but OpenAI |

The AI explains, it doesn't decide: it gets the day's computed reading, and
**every number in its reply must appear in that reading**, or the paragraph is
dropped and the brief goes out without it (the same if the provider errors or
declines). It costs one short request per weekday on your own key. Set only
one key; if several are set, Anthropic is used first, then Gemini.

## Privacy

- Secrets are never printed: GitHub masks them, and the runner keeps your
  plan and wave levels out of the log.
- On a **public fork**, the Actions log is public. It shows the day's market
  reading and how many alerts went out, never their personal content.
- The only thing kept between runs is three dates, in the Actions cache.

## Updating

- **Fork:** click **Sync fork** on your repo page.
- **Private copy:** run once
  `git remote add upstream https://github.com/abhay-sud/market-stress-monitor.git`,
  then `git pull upstream main` whenever you want the latest, and push.

## Good to know

- **Public forks pause after 60 days without a commit.** GitHub emails you
  first; one click on the Actions tab restarts the schedule. Private copies
  don't pause.
- **Free:** a run takes about a minute. Private repos get 2,000 free Actions
  minutes a month; this uses about 40.
- **Data:** S&P 500 and VIX closes from Yahoo Finance (FRED as a fallback);
  the high-yield spread, 10-year yield and Sahm rule from FRED. Each source
  keeps its own terms.
- **Your copy won't run the original's data pipeline.** Its other workflows
  need a Supabase database; they skip themselves unless you set the variable
  `MSM_MODE=full` (see the main [README](../README.md#full-setup)).

## Troubleshooting

- **Nothing arrived:** open the latest *Run your own* run in the Actions tab.
  Run it again with **Print what would be sent** ticked to see the messages
  without sending them.
- **"FRED_API_KEY is not set"** or **"No notification channel is set up":**
  check the secret names exactly as written above.
- **"MY_PLAN is invalid"** or **"my_plan.yaml is invalid":** the message
  names the key that's missing or wrong; compare with the example above.
- **Claude doesn't see the market-stress tools:** check that both paths in
  the config are full paths to your copy and that `npm ci` ran in
  `rule_engine`, then restart the client. In Claude Code, `claude mcp list`
  shows whether the server connected.
- **"No new S&P 500 close" alert:** a data source may be down. The run keeps
  using the last values and retries the next evening.
