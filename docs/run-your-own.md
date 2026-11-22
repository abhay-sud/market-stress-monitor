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
- **"MY_PLAN is invalid":** the message names the key that's missing or
  wrong; compare with the example above.
- **"No new S&P 500 close" alert:** a data source may be down. The run keeps
  using the last values and retries the next evening.
