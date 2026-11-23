// Test helper: loads src/fixtures/lite_history_2026-11-20.json, the raw
// histories as the lite fetcher downloaded them. The rate series are stored as
// whole hundredths of a percent, so the file holds no decimal rate figures for the
// pre-push leak guard to mistake for a personal rate; this converts them back.

import { readFileSync } from "node:fs";
import type { Point } from "./fetch.js";

export interface LiteHistoryFixture {
  sp500: Point[];
  vix: Point[];
  hy_spread_pct: Point[];
  treasury_10y: Point[];
  sahm_rule: Point[];
  fed_target: Point[];
}

export function loadLiteHistoryFixture(): LiteHistoryFixture {
  const raw = JSON.parse(readFileSync(new URL("../fixtures/lite_history_2026-11-20.json", import.meta.url), "utf-8")) as Record<string, Point[]>;
  const fromHundredths = (k: string) => raw[`${k}_x100`].map((p) => ({ date: p.date, value: p.value / 100 }));
  return {
    sp500: raw.sp500,
    vix: raw.vix,
    hy_spread_pct: fromHundredths("hy_spread_pct"),
    treasury_10y: fromHundredths("treasury_10y"),
    sahm_rule: fromHundredths("sahm_rule"),
    fed_target: fromHundredths("fed_target"),
  };
}
