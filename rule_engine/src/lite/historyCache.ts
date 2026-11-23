// Lightweight MCP mode: the fetched history, cached on disk so repeat
// questions don't re-fetch. Refetched when the cache predates the latest
// settled US close (4:30pm New York on a weekday, the same settle buffer as
// parseYahooCloses) or is more than 6 hours old. If a refetch fails, the
// cache is served marked stale.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LiteHistory } from "./fetch.js";

export const MAX_AGE_MS = 6 * 3_600_000;
export const DEFAULT_CACHE_PATH = fileURLToPath(new URL("../../.lite-state/mcp-history.json", import.meta.url));

interface CacheFile {
  version: 1;
  fetched_at: string;
  from: string;
  history: LiteHistory;
}

export interface CachedHistory {
  history: LiteHistory;
  /** First date the replay steps through (the fetch window's start). */
  from: string;
  fetched_at: string;
  /** True when a refetch failed and this is older data. */
  stale: boolean;
  stale_reason?: string;
}

/** Offset of New York from UTC at `at`, in minutes (-240 in summer, -300 in winter). */
function newYorkOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** The most recent weekday 4:30pm New York at or before `now` (market holidays are ignored: an extra refetch is harmless). */
export function lastSettledClose(now: Date): Date {
  const off = newYorkOffsetMinutes(now);
  const ny = new Date(now.getTime() + off * 60_000); // New York wall time, read with UTC getters
  for (let back = 0; back < 8; back++) {
    const day = new Date(Date.UTC(ny.getUTCFullYear(), ny.getUTCMonth(), ny.getUTCDate() - back, 16, 30));
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (day.getTime() > ny.getTime()) continue;
    return new Date(day.getTime() - newYorkOffsetMinutes(day) * 60_000);
  }
  throw new Error("unreachable");
}

export function isFresh(fetchedAt: Date, now: Date): boolean {
  return fetchedAt.getTime() >= lastSettledClose(now).getTime() && now.getTime() - fetchedAt.getTime() < MAX_AGE_MS;
}

export interface CacheDeps {
  fetch: (from: string) => Promise<LiteHistory>;
  now: () => Date;
  path: string;
  /** First date to replay, from the clock (about two years back). */
  fromDate: (now: Date) => string;
}

function readCache(path: string): CacheFile | null {
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
    return c.version === 1 && c.history?.sp500?.length ? c : null;
  } catch {
    return null;
  }
}

/**
 * Returns the history, from memory, disk or a fresh fetch. One fetch runs at
 * a time: concurrent tool calls share it.
 */
export function historyCache(deps: CacheDeps) {
  let memory: CacheFile | null = null;
  let inFlight: Promise<CachedHistory> | null = null;

  async function load(): Promise<CachedHistory> {
    const now = deps.now();
    memory ??= readCache(deps.path);
    if (memory && isFresh(new Date(memory.fetched_at), now)) {
      return { history: memory.history, from: memory.from, fetched_at: memory.fetched_at, stale: false };
    }
    const from = deps.fromDate(now);
    try {
      const history = await deps.fetch(from);
      if (!history.sp500.length) throw new Error("the S&P 500 source returned nothing");
      memory = { version: 1, fetched_at: now.toISOString(), from, history };
      try {
        mkdirSync(dirname(deps.path), { recursive: true });
        writeFileSync(deps.path, JSON.stringify(memory));
      } catch (err) {
        console.error(`cache: not saved (${err instanceof Error ? err.message : String(err)})`);
      }
      return { history, from, fetched_at: memory.fetched_at, stale: false };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!memory) throw new Error(`Couldn't fetch market data and there's no cached copy: ${reason}`);
      return { history: memory.history, from: memory.from, fetched_at: memory.fetched_at, stale: true, stale_reason: reason };
    }
  }

  return {
    get(): Promise<CachedHistory> {
      inFlight ??= load().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
