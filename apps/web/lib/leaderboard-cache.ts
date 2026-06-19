// Tiny TTL cache for the public leaderboard route. The leaderboard is read-only and identical for
// every visitor, so a short in-process cache absorbs bursts of start-screen loads without hammering
// the Rust data API. Pure and time-injectable so it is fully unit-tested.
import type { ScoreEntry } from './api';

export const LEADERBOARD_TTL_MS = 60_000;

interface CacheRecord {
  scores: ScoreEntry[];
  expiresAt: number;
}

const store = new Map<string, CacheRecord>();

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
  store.set(key, { scores, expiresAt: now + LEADERBOARD_TTL_MS });
}

export function clearCache(): void {
  store.clear();
}
