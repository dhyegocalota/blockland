import { describe, expect, it } from 'vitest';
import { AIR, CHUNK, SIZE_X, SIZE_Y, SIZE_Z, WATER_ID, WATER_LEVEL } from './constants';
import { baseVoxel, heightAt } from './worldgen';
import { VoxelWorld } from './world';

const STONE_ID = 3;
const MARKER_ID = 7;

describe('VoxelWorld.chunkKey', () => {
  it('is deterministic and unique per chunk column', () => {
    const world = new VoxelWorld();
    expect(world.chunkKey(0, 0)).toBe(0);
    expect(world.chunkKey(2, 3)).toBe(world.chunkKey(2, 3));
    expect(world.chunkKey(1, 0)).not.toBe(world.chunkKey(0, 1));
  });
});

describe('VoxelWorld.inBounds', () => {
  it('accepts coordinates inside the world volume', () => {
    const world = new VoxelWorld();
    expect(world.inBounds(0, 0, 0)).toBe(true);
    expect(world.inBounds(SIZE_X - 1, SIZE_Y - 1, SIZE_Z - 1)).toBe(true);
  });

  it('rejects coordinates on or past every boundary', () => {
    const world = new VoxelWorld();
    expect(world.inBounds(-1, 0, 0)).toBe(false);
    expect(world.inBounds(0, -1, 0)).toBe(false);
    expect(world.inBounds(0, 0, -1)).toBe(false);
    expect(world.inBounds(SIZE_X, 0, 0)).toBe(false);
    expect(world.inBounds(0, SIZE_Y, 0)).toBe(false);
    expect(world.inBounds(0, 0, SIZE_Z)).toBe(false);
  });
});

describe('VoxelWorld decoration determinism', () => {
  it('generates the identical world (terrain + trees) for every player', () => {
    const a = new VoxelWorld();
    const b = new VoxelWorld();
    // Force the same region to generate in two independent worlds and compare every cell.
    for (let x = 0; x < CHUNK * 2; x++)
      for (let z = 0; z < CHUNK * 2; z++)
        for (let y = 0; y < SIZE_Y; y++) {
          if (a.get(x, y, z) !== b.get(x, y, z)) {
            throw new Error(`worlds diverged at ${x},${y},${z}`);
          }
        }
    // A re-gen after reset() must reproduce the same world too (no Math.random drift).
    const before = a.get(5, heightAt(5, 5) + 1, 5);
    a.reset();
    expect(a.get(5, heightAt(5, 5) + 1, 5)).toBe(before);
  });
});

describe('VoxelWorld.rawGet / rawSet', () => {
  it('reads back what was written without triggering generation', () => {
    const world = new VoxelWorld();
    world.rawSet(8, 12, 8, MARKER_ID);
    expect(world.rawGet(8, 12, 8)).toBe(MARKER_ID);
  });

  it('returns AIR for an unwritten cell in an unallocated chunk', () => {
    const world = new VoxelWorld();
    expect(world.rawGet(100, 5, 100)).toBe(AIR);
  });

  it('returns AIR out of bounds and ignores out-of-bounds writes', () => {
    const world = new VoxelWorld();
    expect(world.rawGet(-1, 0, 0)).toBe(AIR);
    world.rawSet(-1, 0, 0, MARKER_ID);
    expect(world.rawGet(-1, 0, 0)).toBe(AIR);
  });

  it('keeps neighboring cells in the same chunk independent', () => {
    const world = new VoxelWorld();
    world.rawSet(3, 4, 5, MARKER_ID);
    expect(world.rawGet(4, 4, 5)).toBe(AIR);
    expect(world.rawGet(3, 5, 5)).toBe(AIR);
    expect(world.rawGet(3, 4, 6)).toBe(AIR);
  });
});

describe('VoxelWorld.get', () => {
  it('generates terrain lazily that matches the base voxel function', () => {
    const world = new VoxelWorld();
    expect(world.get(50, 0, 50)).toBe(baseVoxel(50, 0, 50));
    const top = heightAt(50, 50);
    expect(world.get(50, top, 50)).toBe(baseVoxel(50, top, 50));
    expect(world.get(50, top + 1, 50)).toBe(baseVoxel(50, top + 1, 50));
  });

  it('returns AIR outside the world bounds', () => {
    const world = new VoxelWorld();
    expect(world.get(-1, 0, 0)).toBe(AIR);
    expect(world.get(0, -1, 0)).toBe(AIR);
    expect(world.get(0, SIZE_Y, 0)).toBe(AIR);
    expect(world.get(SIZE_X, 0, 0)).toBe(AIR);
    expect(world.get(0, 0, SIZE_Z)).toBe(AIR);
  });

  it('returns bedrock at the very bottom of any generated column', () => {
    const world = new VoxelWorld();
    expect(world.get(70, 0, 70)).toBe(baseVoxel(70, 0, 70));
  });
});

describe('VoxelWorld.set', () => {
  it('overrides the generated base voxel', () => {
    const world = new VoxelWorld();
    const generated = world.get(40, 3, 40);
    world.set(40, 3, 40, MARKER_ID);
    expect(world.get(40, 3, 40)).toBe(MARKER_ID);
    expect(world.get(40, 3, 40)).not.toBe(generated);
  });

  it('ignores writes outside bounds', () => {
    const world = new VoxelWorld();
    world.set(-5, 0, 0, MARKER_ID);
    expect(world.get(-5, 0, 0)).toBe(AIR);
  });
});

describe('VoxelWorld.isSolid', () => {
  it('treats placed solid blocks as solid', () => {
    const world = new VoxelWorld();
    world.set(6, 20, 6, STONE_ID);
    expect(world.isSolid(6, 20, 6)).toBe(true);
  });

  it('treats air and water as non-solid', () => {
    const world = new VoxelWorld();
    world.set(4, 20, 4, AIR);
    world.set(5, 20, 5, WATER_ID);
    expect(world.isSolid(4, 20, 4)).toBe(false);
    expect(world.isSolid(5, 20, 5)).toBe(false);
  });

  it('treats out-of-bounds cells as non-solid', () => {
    const world = new VoxelWorld();
    expect(world.isSolid(-1, 5, 5)).toBe(false);
    expect(world.isSolid(5, SIZE_Y, 5)).toBe(false);
  });
});

describe('VoxelWorld.ensureGen', () => {
  it('is idempotent: a manual edit survives a repeated ensureGen of its chunk', () => {
    const world = new VoxelWorld();
    const cx = Math.floor(40 / CHUNK), cz = Math.floor(40 / CHUNK);
    world.ensureGen(cx, cz);
    world.rawSet(40, 22, 40, MARKER_ID);
    world.ensureGen(cx, cz);
    expect(world.rawGet(40, 22, 40)).toBe(MARKER_ID);
  });

  it('does nothing for chunk coordinates outside the world grid', () => {
    const world = new VoxelWorld();
    world.ensureGen(-1, 0);
    world.ensureGen(Math.ceil(SIZE_X / CHUNK), 0);
    expect(world.snapshot().size).toBe(0);
  });

  it('allocates exactly one chunk per generated column', () => {
    const world = new VoxelWorld();
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
    const world = new VoxelWorld();
    world.set(9, 13, 9, MARKER_ID);
    const snapshot = world.snapshot();
    const key = world.chunkKey(Math.floor(9 / CHUNK), Math.floor(9 / CHUNK));
    expect(snapshot.has(key)).toBe(true);

    snapshot.delete(key);
    expect(world.get(9, 13, 9)).toBe(MARKER_ID);
  });

  it('starts empty before any generation or edit', () => {
    const world = new VoxelWorld();
    expect(world.snapshot().size).toBe(0);
  });
});

describe('VoxelWorld terrain generation', () => {
  it('matches baseVoxel for every cell from bedrock to the surface (decoration never rewrites buried voxels)', () => {
    const world = new VoxelWorld();
    const x = 55, z = 73;
    const top = heightAt(x, z);
    for (let y = 0; y <= top; y++) expect(world.get(x, y, z)).toBe(baseVoxel(x, y, z));
  });

  it('fills water up to the water level above a submerged column', () => {
    const world = new VoxelWorld();
    let column: { x: number; z: number } | null = null;
    for (let x = 0; x < CHUNK && !column; x++)
      for (let z = 0; z < CHUNK && !column; z++)
        if (heightAt(x, z) < WATER_LEVEL) column = { x, z };
    if (!column) return;
    const top = heightAt(column.x, column.z);
    expect(world.get(column.x, top + 1, column.z)).toBe(WATER_ID);
    expect(world.get(column.x, WATER_LEVEL, column.z)).toBe(WATER_ID);
  });
});
