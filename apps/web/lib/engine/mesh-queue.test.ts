import { describe, expect, it } from 'vitest';
import { enqueueChunks, shouldMeshDequeued, sortQueueByDistance } from './mesh-queue';

describe('enqueueChunks', () => {
  it('keeps only chunks that are neither meshed nor queued', () => {
    const candidates = [
      { cx: 0, cz: 0, key: 0 },
      { cx: 1, cz: 0, key: 1 },
      { cx: 2, cz: 0, key: 2 },
    ];
    const fresh = enqueueChunks({
      candidates,
      isMeshed: (key) => key === 0,
      isQueued: (key) => key === 1,
    });
    expect(fresh).toEqual([{ cx: 2, cz: 0, key: 2 }]);
  });

  it('returns everything when nothing is meshed or queued', () => {
    const candidates = [{ cx: 0, cz: 0, key: 0 }, { cx: 1, cz: 0, key: 1 }];
    const fresh = enqueueChunks({ candidates, isMeshed: () => false, isQueued: () => false });
    expect(fresh).toEqual(candidates);
  });
});

describe('sortQueueByDistance', () => {
  it('orders nearest-first around the center', () => {
    const queue = [
      { cx: 3, cz: 0, key: 3 },
      { cx: 1, cz: 0, key: 1 },
      { cx: 2, cz: 0, key: 2 },
    ];
    sortQueueByDistance({ queue, center: { cx: 0, cz: 0 } });
    expect(queue.map((c) => c.key)).toEqual([1, 2, 3]);
  });
});

describe('shouldMeshDequeued', () => {
  const center = { cx: 0, cz: 0 };

  it('meshes a near, unmeshed chunk', () => {
    expect(shouldMeshDequeued({ chunk: { cx: 1, cz: 0, key: 1 }, center, radius: 4, isMeshed: () => false })).toBe(true);
  });

  it('skips a chunk that was meshed while it waited', () => {
    expect(shouldMeshDequeued({ chunk: { cx: 1, cz: 0, key: 1 }, center, radius: 4, isMeshed: () => true })).toBe(false);
  });

  it('skips a chunk that drifted out of the keep range', () => {
    expect(shouldMeshDequeued({ chunk: { cx: 99, cz: 0, key: 99 }, center, radius: 4, isMeshed: () => false })).toBe(false);
  });
});
