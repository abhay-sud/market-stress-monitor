-- Describe hazard_scorecard (2026-11-22). Metadata only: no schema or data
-- change. Also the first migration applied by the Supabase GitHub
-- integration after its history was repaired (all 31 earlier versions marked
-- applied), confirming that a push to main applies only new migrations.

comment on table public.hazard_scorecard is
  'Daily side-by-side record of the drawdown risk band (drawdown % + VIX/5) and the retired logistic hazard model, scored later against what the S&P 500 actually did. Public read-only.';
