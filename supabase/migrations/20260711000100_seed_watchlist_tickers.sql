-- One-time seed matching local_state/brokerage_window_watchlist.yaml's current
-- 7 tickers (seeded from master-prompt-original.md's original table). Future
-- additions/removals go through write_watchlist, not a migration.
insert into watchlist_tickers (symbol) values
  ('TICKER'), ('LNG'), ('TICKER'), ('TICKER'), ('TICKER'), ('TICKER'), ('NVDA')
on conflict (symbol) do nothing;
