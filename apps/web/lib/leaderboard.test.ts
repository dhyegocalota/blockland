import { beforeAll, describe, expect, it } from 'vitest';

let store: typeof import('./leaderboard');

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  store = await import('./leaderboard');
});

describe('leaderboard', () => {
  it('submits scores and returns them ordered desc', async () => {
    await store.submitScore({ tenant: 'teo', name: 'Ann', score: 30 });
    await store.submitScore({ tenant: 'teo', name: 'Bob', score: 50 });
    await store.submitScore({ tenant: 'teo', name: 'Cid', score: 40 });

    const top = await store.topScores('teo');
    expect(top.map((e) => e.name)).toEqual(['Bob', 'Cid', 'Ann']);
    expect(top.map((e) => e.score)).toEqual([50, 40, 30]);
  });

  it('keeps only the best score per name', async () => {
    await store.submitScore({ tenant: 'teo', name: 'Ann', score: 100 });
    await store.submitScore({ tenant: 'teo', name: 'Ann', score: 10 });

    const top = await store.topScores('teo');
    const ann = top.filter((e) => e.name === 'Ann');
    expect(ann).toHaveLength(1);
    expect(ann[0].score).toBe(100);
  });

  it('isolates scores per tenant', async () => {
    await store.submitScore({ tenant: 'demo', name: 'Zoe', score: 5 });
    const teo = await store.topScores('teo');
    expect(teo.map((e) => e.name)).not.toContain('Zoe');
  });

  it('truncates names to 16 chars', async () => {
    await store.submitScore({ tenant: 'names', name: 'abcdefghijklmnopqrstuv', score: 1 });
    const top = await store.topScores('names');
    expect(top[0].name).toBe('abcdefghijklmnop');
  });

  it('rejects an empty name', async () => {
    await expect(store.submitScore({ tenant: 'teo', name: '   ', score: 1 })).rejects.toThrow();
  });

  it('rejects an empty tenant', async () => {
    await expect(store.submitScore({ tenant: '  ', name: 'Ann', score: 1 })).rejects.toThrow();
  });

  it('rejects non-integer, negative, and non-finite scores', async () => {
    await expect(store.submitScore({ tenant: 'teo', name: 'Ann', score: 1.5 })).rejects.toThrow();
    await expect(store.submitScore({ tenant: 'teo', name: 'Ann', score: -1 })).rejects.toThrow();
    await expect(store.submitScore({ tenant: 'teo', name: 'Ann', score: Infinity })).rejects.toThrow();
  });

  it('clamps the limit', async () => {
    for (let i = 0; i < 15; i += 1) {
      await store.submitScore({ tenant: 'big', name: `p${i}`, score: i });
    }
    const top = await store.topScores('big', 5);
    expect(top).toHaveLength(5);
    expect(top[0].score).toBe(14);
  });
});
