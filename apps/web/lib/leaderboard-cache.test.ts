import { afterEach, describe, expect, it } from 'vitest';
import { LEADERBOARD_MAX_ENTRIES, LEADERBOARD_TTL_MS, clearCache, readCache, writeCache } from './leaderboard-cache';

afterEach(() => clearCache());

describe('leaderboard cache', () => {
  it('returns null for an unknown key', () => {
    expect(readCache('teo:all', 0)).toBeNull();
  });

  it('reads back a written record within the ttl', () => {
    const scores = [{ name: 'Ana', score: 42 }];
    writeCache('teo:all', scores, 1_000);
    expect(readCache('teo:all', 1_000 + LEADERBOARD_TTL_MS - 1)).toEqual(scores);
  });

  it('expires a record once the ttl has passed', () => {
    writeCache('teo:all', [{ name: 'Ana', score: 42 }], 1_000);
    expect(readCache('teo:all', 1_000 + LEADERBOARD_TTL_MS)).toBeNull();
  });

  it('keeps the all-time and month boards under separate keys', () => {
    writeCache('teo:all', [{ name: 'Ana', score: 42 }], 0);
    writeCache('teo:month', [{ name: 'Bea', score: 9 }], 0);
    expect(readCache('teo:month', 0)).toEqual([{ name: 'Bea', score: 9 }]);
  });

  it('never grows past the entry ceiling', () => {
    for (let i = 0; i < LEADERBOARD_MAX_ENTRIES + 200; i++) {
      writeCache(`tenant${i}:all`, [{ name: 'X', score: i }], 0);
    }
    let live = 0;
    for (let i = 0; i < LEADERBOARD_MAX_ENTRIES + 200; i++) {
      if (readCache(`tenant${i}:all`, 0) !== null) live++;
    }
    expect(live).toBeLessThanOrEqual(LEADERBOARD_MAX_ENTRIES);
  });
});
