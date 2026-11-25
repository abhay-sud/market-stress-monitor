# AGENTS.md

Dev-tooling guide for coding agents (Claude Code, GitHub Copilot, etc.)
working in this repo. This is **not** the runtime behavior spec — for
rule thresholds, bands, and wave logic, see
`reference_docs/rules/crash-check-rules.md`. For the Claude Desktop
chat workflow itself, see `reference_docs/rules/project-instructions.md`.
Neither of those files should be restated here; only pointed to.

## What this repo is

A market-crash-monitoring pipeline: scheduled data ingestion → a
deterministic rule engine → a local MCP server (Claude Desktop) → two
static reporting sites. See `README.md` for the full architecture
diagram. Four independent Node packages, each with its own
`package.json`/lockfile — there is no root-level workspace tooling.

## Package responsibilities

| Package | Role | Run from |
|---|---|---|
| `ingestion/` | Pulls FRED/EIA/CBOE/Massive/Polymarket/SEC data into Supabase `data_points`. No LLM, no classification logic. | `ingestion/` |
| `rule_engine/` | Deterministic RED/AMBER/GREEN classification, the 3-of-6 stress gate (information only since 2026-11-19), hazard model. Reads `data_points`, writes `crash_checks`. The per-day panel logic is `src/panelStep.ts`, shared with `src/lite/` (the "run your own" alerts-only copy, `npm run lite`, no database; spec `reference_docs/BUILD_SPEC_run_your_own.md`). | `rule_engine/` |
| `mcp_server/` | Local stdio MCP server for Claude Desktop. Merges Supabase state with `local_state/portfolio.yaml` at read-time only — never writes portfolio data anywhere. Run via `npx tsx src/server.ts` from this working tree (not published/installed). | `mcp_server/` |
| `dashboard_site/` + `full_report_site/` | Static Cloudflare Pages sites (no build step, no `package.json`). `full_report_site` has a Pages Function (`functions/index.ts`) behind Cloudflare Access. `dashboard_site/_worker.js` (scoped by `_routes.json` to `/`, the tab URLs `/smart-money`, `/macro`, `/views`, `/latest.md`, `/sitemap.xml` and `/feed.xml`) puts the latest reading into the HTML (and the home page's meta description) for crawlers and AI tools, dates the sitemap, serves a daily Atom feed at `/feed.xml`, sets each tab URL's title/description/canonical (`TAB_PAGES`, mirrored by `TAB_PATHS`/`TAB_TITLES` in `index.html`) and renders `analyst_views.json` as HTML at `/views`; it copies the indicator formats and the drawdown-risk-band labels, rates and fallback formula (`ddVixReading`) from `index.html` and targets `#stress-verdict` / `#site-summary`, so change them together. | n/a |
| `supabase/migrations/` | SQL migrations. The Supabase GitHub integration applies new ones automatically on every push to `main` (its history is `supabase_migrations.schema_migrations`); don't also run them by hand. Push a migration one push before any code that needs it, and never edit or rename one already pushed. | n/a |

## Build / typecheck commands

Each of the three Node packages is independent — install and typecheck
from inside that package's directory, not the repo root:

```bash
cd ingestion && npm ci && npm run typecheck
cd rule_engine && npm ci && npm run typecheck
cd mcp_server && npm ci && npm run typecheck
```

`rule_engine` has a Vitest suite for its pure rule logic (`npm test`,
covering `rules.ts`); `mcp_server` has a small `node:test` suite (`npm
test`, no framework dependency) covering the deployment-instrument
registry, readiness/fire drill, trading limits, the filing classifier
and role-fit math (pure functions only; no network). `ingestion` and the rest of `mcp_server` still rely on
`tsc --noEmit` plus manual verification (see `BACKLOG.md` for the
remaining gap). Not wired into GitHub Actions; run locally only. Don't
add a CI step or linter as part of an unrelated change.

All three packages require Node >=22 (`engines.node` in each
`package.json`) — matches what `.github/workflows/*.yml` installs via
`actions/setup-node@v4`.

## Working-directory convention

GitHub Actions workflows (`.github/workflows/ingest.yml`,
`backfill.yml`, `sec13f.yml`, `run-your-own.yml`) each set
`defaults.run.working-directory` to the one package they invoke, then
`npm ci` + a single `npm run <script>`. The first three run only in this
repo or a copy that sets the `MSM_MODE=full` variable; `run-your-own.yml`
runs on schedule only in other copies (manual runs work anywhere). Match this convention for any new workflow or local script:
operate from inside one package's directory, never add root-level
install/build steps.

## Making a rule change safely

1. Threshold **values** live in config files, not code:
   - `config/monitoring.yaml` (public): panel bands, confirmation days,
     the stress gate (3 of 6), whether deployment requires it
     (`stress_gate_required`, false since 2026-11-19). Phone alerts are
     the local wave-trigger alert (`mcp_server/src/scripts/waveAlert.ts`). Read by both
     `rule_engine/src/rules.ts` and `mcp_server/src/lib/monitoring.ts`,
     each with its own validating loader; the file is the single source.
   - `local_state/policy.yaml` (gitignored, local-only; shape in
     `local_state/policy.example.yaml`): wave and crash-type deployment
     percentages, read by `mcp_server/src/lib/waveDeployment.ts` on every
     call. Tests use the example file, never the real one.
   - The wave triggers are in the same local policy (`wave_triggers`) and
     are evaluated locally by `mcp_server/src/lib/waveEvaluation.ts` from
     public inputs the rule engine publishes (drawdown, VIX,
     `sp500_days_since_252d_low`). The rule engine never decides waves and
     no wave field is stored on the public `crash_checks` table. The "run
     your own" copy evaluates a user's own triggers with copies of
     `waveEvaluation.ts` and `waveAlert.ts` in `rule_engine/src/lite/plan.ts`;
     change them together. Its lightweight MCP server (`npm run mcp`,
     `rule_engine/src/lite/mcp.ts`) copies `computeWaveDeployment` and the
     5/25 drift rule into `rule_engine/src/lite/money.ts`, and the rules-doc
     section lookup into `lite/rulesDoc.ts`; `config/fixtures/lite-money.json`
     is checked by a test in both packages.
   - The Fed pivot's data floor (`rule_engine/src/fedPivot.ts`) keeps a copy
     of the FOMC dates in `mcp_server/src/lib/economicCalendar.ts`; extend
     both together (a test checks they match). `write_snapshot` enforces the
     floor via `mcp_server/src/lib/fedPivotInput.ts`.

   The prose rationale stays in `reference_docs/rules/crash-check-rules.md`.
   After any change, run `npm run typecheck` and `npm test` in both
   packages.
2. `rule_engine/src/lib/seriesDelta.ts` and
   `mcp_server/src/lib/seriesDelta.ts` are separate copies that have
   already diverged — read both before changing either; don't assume
   they're identical.
3. Never edit the bands in `config/monitoring.yaml` without also checking
   `dashboard_site/` for hardcoded chart bands (VIX 20/35, HY spread
   350/500bp, 10yr yield 4.3/5.0, Sahm 0.3/0.5). The dashboard doesn't
   read the config at render time. The drawdown risk band (score =
   drawdown % + VIX / 5, cutoffs 8.5 / 10) lives in
   `rule_engine/src/hazardScorecard.ts` and is copied, with its hit rates,
   into `dashboard_site/index.html`, `dashboard_site/_worker.js`,
   `mcp_server/src/server.ts`, `full_report_site/functions/index.ts` and
   `rule_engine/src/lite/events.ts`.
   Those cutoffs were fixed before any live outcome and must not be
   retuned from live results.
   The scenario prior (`config/scenario_prior_v1.json`: the historical
   bull/base/bear/crash split per band and the 5-point tilt step) is a
   frozen release from the private research repo; replace it only with a
   new versioned release, never by hand or from live outcomes. Its splits
   are copied into `dashboard_site/index.html` (`SCENARIO_PRIOR`) and
   `_worker.js` (`SCENARIO_PRIOR_FALL10`), and the tilt rule in
   `mcp_server/src/lib/scenarioTilt.ts` must keep reproducing the file's
   `samples` (its test checks this).
4. Never write real portfolio/dollar data outside `local_state/*.yaml`
   (gitignored) — only the `*.example.yaml` templates are tracked.
5. Personal policy stays out of tracked files: wave splits, crash-type
   allocations, plan-specific rules, account names and watchlist tickers.
   The public rules doc keeps a generic stub under each personal heading;
   the real text lives in `local_state/personal-rules.md`, which `get_rules`
   merges in by matching `##`/`###` heading text, so keep those headings
   identical in both files. Code uses generic names (`tactical` account,
   `brokerage_window` route, `watchlist.yaml`); real labels live in the
   local files. Watchlist ticker prices go to the service-role-only
   `private_data_points` table, personal triggers and wave status to
   `full_report_snapshots`; `write_snapshot` rejects public text containing
   the policy's `private_terms`.
6. A pre-push leak guard (`.githooks/leak-guard.mjs`, enabled per clone
   with `git config core.hooksPath .githooks`) blocks any push whose new
   commits contain the policy's private terms, watchlist tickers, fund
   names, dollar figures, the extra identity terms in
   `local_state/leak-guard.yaml`, secrets or real `local_state` files. It
   reads those lists from the gitignored local files at push time. Don't
   bypass it with `--no-verify`; fix the commit, or add a genuine false
   positive to `allow_terms` in the local file.

## Do not

- Don't add a CI linter, another git hook, or test framework — single
  maintainer, zero ongoing-maintenance budget. The pre-push leak guard is
  the one deliberate exception (personal-data safety, no dependencies).
- Don't rename or move `reference_docs/rules/crash-check-rules.md`,
  `reference_docs/rules/project-instructions.md` or
  `reference_docs/rules/portfolio-review-template.html` — all three are read
  by path from this repo's own code, not attached as Claude Desktop project
  knowledge: `get_instructions` serves the instructions and the review
  template whole (since 2026-11-15, so the project no longer depends on the
  GitHub connector, which only works for public repos), and `get_rules`
  serves the rules doc section by section (attached, it hit Claude Desktop's
  full-load size limit). Changes take effect on the next tool call; no
  project Sync is needed. Keep `## ` / `### ` headings stable: they are the
  section names runs ask `get_rules` for.
- Don't restate rule thresholds or architecture here — link to them.
