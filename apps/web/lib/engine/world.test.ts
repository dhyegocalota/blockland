import { describe, expect, it } from 'vitest';
import { AIR, CHUNK, SIZE_X, SIZE_Y, SIZE_Z, WATER_ID } from './constants';
import { VoxelWorld } from './world';
import { emptyWorldgen, fakeWorldgen, makeTestWorld } from './test-world';

const STONE_ID = 3;
const MARKER_ID = 7;

// The store tests run on a fake worldgen — the real terrain/decoration/monument generation is the shared
// Rust source, proven byte-identical by worldgen-parity.test.ts and the sim golden test. Here we only
// prove the STORE contract: it fills a chunk's base from its worldgen once, caches it, and overlays edits.

describe('VoxelWorld.chunkKey', () => {
  it('is deterministic and unique per chunk column', () => {
    const world = makeTestWorld();
    expect(world.chunkKey(0, 0)).toBe(0);
    expect(world.chunkKey(2, 3)).toBe(world.chunkKey(2, 3));
    expect(world.chunkKey(1, 0)).not.toBe(world.chunkKey(0, 1));
  });
});

describe('VoxelWorld.inBounds', () => {
  it('accepts coordinates inside the world volume', () => {
    const world = makeTestWorld();
    expect(world.inBounds(0, 0, 0)).toBe(true);
    expect(world.inBounds(SIZE_X - 1, SIZE_Y - 1, SIZE_Z - 1)).toBe(true);
  });

  it('rejects coordinates on or past every boundary', () => {
    const world = makeTestWorld();
    expect(world.inBounds(-1, 0, 0)).toBe(false);
    expect(world.inBounds(0, -1, 0)).toBe(false);
    expect(world.inBounds(0, 0, -1)).toBe(false);
    expect(world.inBounds(SIZE_X, 0, 0)).toBe(false);
    expect(world.inBounds(0, SIZE_Y, 0)).toBe(false);
    expect(world.inBounds(0, 0, SIZE_Z)).toBe(false);
  });
});

describe('VoxelWorld base fill from worldgen', () => {
  // A worldgen that paints each cell with a value derived from its world coordinates, so we can predict
  // exactly what the store should read back from the cached base.
  const coordFill = (x: number, y: number, z: number): number => ((x + y * 3 + z * 7) % 5) + 1;

  it('reads back exactly what its worldgen filled, for every cell of a chunk', () => {
    const world = makeTestWorld(fakeWorldgen(coordFill));
    for (let x = 0; x < CHUNK; x++)
      for (let z = 0; z < CHUNK; z++)
        for (let y = 0; y < SIZE_Y; y++)
          expect(world.get(x, y, z)).toBe(coordFill(x, y, z));
  });

  it('fills the same base for every player (independent worlds agree) and after reset()', () => {
    const a = makeTestWorld(fakeWorldgen(coordFill));
    const b = makeTestWorld(fakeWorldgen(coordFill));
    for (let x = 0; x < CHUNK * 2; x++)
      for (let z = 0; z < CHUNK * 2; z++)
        for (let y = 0; y < SIZE_Y; y++)
          expect(a.get(x, y, z)).toBe(b.get(x, y, z));
    const before = a.get(5, 6, 5);
    a.reset();
    expect(a.get(5, 6, 5)).toBe(before);
  });

  it('calls its worldgen exactly once per chunk (caches the base)', () => {
    const calls: Array<[number, number]> = [];
    const counting = fakeWorldgen(() => 0);
    const wrapped: typeof counting = (cx, cz) => { calls.push([cx, cz]); return counting(cx, cz); };
    const world = new VoxelWorld(wrapped);
    world.get(5, 6, 5);
    world.get(6, 7, 6);
    expect(calls).toEqual([[0, 0]]);
    world.get(CHUNK + 1, 6, 1);
    expect(calls).toEqual([[0, 0], [1, 0]]);
  });
});

describe('VoxelWorld.rawGet / rawSet', () => {
  it('reads back what was written without triggering generation', () => {
    const world = makeTestWorld();
    world.rawSet(8, 12, 8, MARKER_ID);
    expect(world.rawGet(8, 12, 8)).toBe(MARKER_ID);
  });

  it('returns AIR for an unwritten cell in an unallocated chunk', () => {
    const world = makeTestWorld();
    expect(world.rawGet(100, 5, 100)).toBe(AIR);
  });

  it('returns AIR out of bounds and ignores out-of-bounds writes', () => {
    const world = makeTestWorld();
    expect(world.rawGet(-1, 0, 0)).toBe(AIR);
    world.rawSet(-1, 0, 0, MARKER_ID);
    expect(world.rawGet(-1, 0, 0)).toBe(AIR);
  });

  it('keeps neighboring cells in the same chunk independent', () => {
    const world = makeTestWorld();
    world.rawSet(3, 4, 5, MARKER_ID);
    expect(world.rawGet(4, 4, 5)).toBe(AIR);
    expect(world.rawGet(3, 5, 5)).toBe(AIR);
    expect(world.rawGet(3, 4, 6)).toBe(AIR);
  });
});

describe('VoxelWorld.get', () => {
  it('returns AIR outside the world bounds', () => {
    const world = makeTestWorld();
    expect(world.get(-1, 0, 0)).toBe(AIR);
    expect(world.get(0, -1, 0)).toBe(AIR);
    expect(world.get(0, SIZE_Y, 0)).toBe(AIR);
    expect(world.get(SIZE_X, 0, 0)).toBe(AIR);
    expect(world.get(0, 0, SIZE_Z)).toBe(AIR);
  });
});

describe('VoxelWorld.set', () => {
  it('overrides the generated base voxel', () => {
    const world = makeTestWorld(fakeWorldgen(() => STONE_ID));
    expect(world.get(40, 3, 40)).toBe(STONE_ID);
    world.set(40, 3, 40, MARKER_ID);
    expect(world.get(40, 3, 40)).toBe(MARKER_ID);
  });

  it('ignores writes outside bounds', () => {
    const world = makeTestWorld();
    world.set(-5, 0, 0, MARKER_ID);
    expect(world.get(-5, 0, 0)).toBe(AIR);
  });
});

describe('VoxelWorld.isSolid', () => {
  it('treats placed solid blocks as solid', () => {
    const world = makeTestWorld();
    world.set(6, 20, 6, STONE_ID);
    expect(world.isSolid(6, 20, 6)).toBe(true);
  });

  it('treats air and water as non-solid', () => {
    const world = makeTestWorld();
    world.set(4, 20, 4, AIR);
    world.set(5, 20, 5, WATER_ID);
    expect(world.isSolid(4, 20, 4)).toBe(false);
    expect(world.isSolid(5, 20, 5)).toBe(false);
  });

  it('treats out-of-bounds cells as non-solid', () => {
    const world = makeTestWorld();
    expect(world.isSolid(-1, 5, 5)).toBe(false);
    expect(world.isSolid(5, SIZE_Y, 5)).toBe(false);
  });
});

describe('VoxelWorld.ensureGen', () => {
  it('is idempotent: a manual edit survives a repeated ensureGen of its chunk', () => {
    const world = makeTestWorld();
    const cx = Math.floor(40 / CHUNK), cz = Math.floor(40 / CHUNK);
    world.ensureGen(cx, cz);
    world.rawSet(40, 22, 40, MARKER_ID);
    world.ensureGen(cx, cz);
    expect(world.rawGet(40, 22, 40)).toBe(MARKER_ID);
  });

  it('does nothing for chunk coordinates outside the world grid', () => {
    const world = makeTestWorld();
    world.ensureGen(-1, 0);
    world.ensureGen(Math.ceil(SIZE_X / CHUNK), 0);
    expect(world.snapshot().size).toBe(0);
  });

  it('allocates exactly one chunk per generated column', () => {
    const world = makeTestWorld();
    world.get(40, 5, 40);
    expect(world.snapshot().size).toBe(1);
    world.get(41, 5, 41);
    expect(world.snapshot().size).toBe(1);
    world.get(40 + CHUNK, 5, 40);
    expect(world.snapshot().size).toBe(2);
  });
});

describe('VoxelWorld.snapshot', () => {
  it('reflects edits and is a detached copy of the chunk map', () => {
    const world = makeTestWorld();
    world.set(9, 13, 9, MARKER_ID);
    const snapshot = world.snapshot();
    const key = world.chunkKey(Math.floor(9 / CHUNK), Math.floor(9 / CHUNK));
    expect(snapshot.has(key)).toBe(true);

    snapshot.delete(key);
    expect(world.get(9, 13, 9)).toBe(MARKER_ID);
  });

  it('starts empty before any generation or edit', () => {
    const world = makeTestWorld();
    expect(world.snapshot().size).toBe(0);
  });
});

describe('VoxelWorld edits do not write through to the worldgen source', () => {
  it('owns a fresh copy of the base so an edit never mutates a shared worldgen buffer', () => {
    const shared = new Uint8Array(CHUNK * CHUNK * SIZE_Y);
    const world = new VoxelWorld(() => shared);
    world.set(1, 2, 3, MARKER_ID);
    expect(world.get(1, 2, 3)).toBe(MARKER_ID);
    // The worldgen's own buffer is untouched (the store copied it on fill).
    expect(shared[1 + 3 * CHUNK + 2 * CHUNK * CHUNK]).toBe(AIR);
  });

  it('keeps emptyWorldgen all air', () => {
    const world = new VoxelWorld(emptyWorldgen);
    expect(world.get(3, 4, 5)).toBe(AIR);
  });
});
