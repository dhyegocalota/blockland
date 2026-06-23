import { describe, expect, it } from 'vitest';
import { findSpawnSlot, spawnColumnClear } from './spawn-slot';
import { SPAWN_CLEARANCE_GAP } from './constants';

describe('findSpawnSlot', () => {
  it('returns the base when the base column is clear', () => {
    const slot = findSpawnSlot({ baseX: 10, baseZ: 20, maxRadius: 4, isClear: () => true });
    expect(slot).toEqual({ x: 10, z: 20 });
  });

  it('falls back to the base when nothing within the radius is clear', () => {
    const slot = findSpawnSlot({ baseX: 5, baseZ: 5, maxRadius: 3, isClear: () => false });
    expect(slot).toEqual({ x: 5, z: 5 });
  });

  it('picks the nearest ring when only the base column is blocked', () => {
    const slot = findSpawnSlot({
      baseX: 0,
      baseZ: 0,
      maxRadius: 4,
      isClear: (x, z) => !(x === 0 && z === 0),
    });
    expect(Math.max(Math.abs(slot.x), Math.abs(slot.z))).toBe(1);
  });

  it('skips a fully blocked first ring and lands on the next', () => {
    const slot = findSpawnSlot({
      baseX: 0,
      baseZ: 0,
      maxRadius: 4,
      isClear: (x, z) => Math.max(Math.abs(x), Math.abs(z)) >= 2,
    });
    expect(Math.max(Math.abs(slot.x), Math.abs(slot.z))).toBe(2);
  });

  it('scans a ring in a deterministic order (top-left row first)', () => {
    const clear: Array<[number, number]> = [];
    findSpawnSlot({
      baseX: 0,
      baseZ: 0,
      maxRadius: 1,
      isClear: (x, z) => {
        clear.push([x, z]);
        return false;
      },
    });
    expect(clear[0]).toEqual([0, 0]);
    expect(clear[1]).toEqual([-1, -1]);
    expect(clear[clear.length - 1]).toEqual([1, 1]);
  });
});

describe('spawnColumnClear', () => {
  const flatGround = (): number => 30;
  const allAir = (): boolean => false;

  it('is clear when the body cells are air and no actor is near', () => {
    const clear = spawnColumnClear({
      x: 0, z: 0, clearanceGap: SPAWN_CLEARANCE_GAP,
      surfaceY: flatGround, isSolid: allAir, actors: [],
    });
    expect(clear).toBe(true);
  });

  it('is not clear when a body cell above the surface is solid', () => {
    const clear = spawnColumnClear({
      x: 0, z: 0, clearanceGap: SPAWN_CLEARANCE_GAP,
      surfaceY: flatGround, isSolid: (_x, y) => y === 31, actors: [],
    });
    expect(clear).toBe(false);
  });

  it('is not clear when a creature sits on the column', () => {
    const clear = spawnColumnClear({
      x: 0, z: 0, clearanceGap: SPAWN_CLEARANCE_GAP,
      surfaceY: flatGround, isSolid: allAir, actors: [{ x: 0.5, z: 0.5 }],
    });
    expect(clear).toBe(false);
  });

  it('offline spawn slides off a creature sitting on the base column', () => {
    const creatureOnBase = [{ x: 0.5, z: 0.5 }];
    const slot = findSpawnSlot({
      baseX: 0, baseZ: 0, maxRadius: 6,
      isClear: (x, z) => spawnColumnClear({
        x, z, clearanceGap: SPAWN_CLEARANCE_GAP,
        surfaceY: flatGround, isSolid: allAir, actors: creatureOnBase,
      }),
    });
    expect(slot).not.toEqual({ x: 0, z: 0 });
    expect(Math.max(Math.abs(slot.x), Math.abs(slot.z))).toBe(1);
  });
});
