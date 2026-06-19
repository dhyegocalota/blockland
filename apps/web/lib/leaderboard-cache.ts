// Tiny TTL cache for the public leaderboard route. The leaderboard is read-only and identical for
// every visitor, so a short in-process cache absorbs bursts of start-screen loads without hammering
// the Rust data API. Pure and time-injectable so it is fully unit-tested.
import type { ScoreEntry } from './api';

export const LEADERBOARD_TTL_MS = 60_000;
// Hard ceiling on distinct (tenant, window) keys so a platform with many tenants can never grow the
// in-process cache without bound. New writes prune expired records, then evict the oldest if still full.
export const LEADERBOARD_MAX_ENTRIES = 500;

interface CacheRecord {
  scores: ScoreEntry[];
  expiresAt: number;
}

const store = new Map<string, CacheRecord>();

function evictIfFull(key: string, now: number): void {
  if (store.has(key) || store.size < LEADERBOARD_MAX_ENTRIES) return;
  for (const [existing, record] of store) {
    if (record.expiresAt <= now) store.delete(existing);
  }
  if (store.size < LEADERBOARD_MAX_ENTRIES) return;
  const oldest = store.keys().next().value;
  if (oldest !== undefined) store.delete(oldest);
}

export function readCache(key: string, now: number): ScoreEntry[] | null {
  const record = store.get(key);
  if (!record) return null;
  if (record.expiresAt <= now) {
    store.delete(key);
    return null;
  }
  return record.scores;
}

export function writeCache(key: string, scores: ScoreEntry[], now: number): void {
  evictIfFull(key, now);
  store.set(key, { scores, expiresAt: now + LEADERBOARD_TTL_MS });
}

export function clearCache(): void {
  store.clear();
}
