import { describe, expect, it } from 'vitest';
import { EYE_HEIGHT, GRASS_ID, PLAYER_HEIGHT, PLAYER_RADIUS, SIZE_Y, WATER_ID } from './constants';
import { type PlayerBody, collide, moveAxis } from './physics';
import { VoxelWorld } from './world';
import { heightAt } from './worldgen';

// heightAt is clamped to SIZE_Y - 5, so any column above that is guaranteed air.
// We test physics against blocks we place by hand in that empty upper region.
const AIR_FLOOR_Y = SIZE_Y - 4;

function bodyAt({ x, y, z }: { x: number; y: number; z: number }): PlayerBody {
  return { pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, onGround: false };
}

describe('collide', () => {
  it('returns true when the player AABB overlaps a solid block', () => {
    const world = new VoxelWorld();
    const blockX = 100, blockY = AIR_FLOOR_Y, blockZ = 100;
    world.set(blockX, blockY, blockZ, GRASS_ID);
    const pos = { x: blockX + 0.5, y: blockY + EYE_HEIGHT, z: blockZ + 0.5 };
    expect(collide({ world, pos })).toBe(true);
  });

  it('returns false when the player AABB is in open air', () => {
    const world = new VoxelWorld();
    const pos = { x: 200.5, y: AIR_FLOOR_Y + 10 + EYE_HEIGHT, z: 200.5 };
    expect(collide({ world, pos })).toBe(false);
  });

  it('does not treat water as a solid collider', () => {
    const world = new VoxelWorld();
    const blockX = 300, blockY = AIR_FLOOR_Y, blockZ = 300;
    world.set(blockX, blockY, blockZ, WATER_ID);
    const pos = { x: blockX + 0.5, y: blockY + EYE_HEIGHT, z: blockZ + 0.5 };
    expect(collide({ world, pos })).toBe(false);
  });

  it('detects collision spanning the full player height', () => {
    const world = new VoxelWorld();
    const baseX = 400, baseZ = 400, feetY = AIR_FLOOR_Y;
    const headBlockY = Math.floor(feetY + PLAYER_HEIGHT);
    world.set(baseX, headBlockY, baseZ, GRASS_ID);
    const pos = { x: baseX + 0.5, y: feetY + EYE_HEIGHT, z: baseZ + 0.5 };
    expect(collide({ world, pos })).toBe(true);
  });

  it('respects the player radius on the horizontal extents', () => {
    const world = new VoxelWorld();
    const feetY = AIR_FLOOR_Y, blockZ = 501;
    world.set(500, feetY, blockZ, GRASS_ID);
    const justClear = { x: 500.5, y: feetY + EYE_HEIGHT, z: blockZ - PLAYER_RADIUS - 0.01 };
    const touching = { x: 500.5, y: feetY + EYE_HEIGHT, z: blockZ - PLAYER_RADIUS + 0.01 };
    expect(collide({ world, pos: justClear })).toBe(false);
    expect(collide({ world, pos: touching })).toBe(true);
  });
});

describe('moveAxis', () => {
  it('moves freely through open air and keeps velocity', () => {
    const world = new VoxelWorld();
    const player = bodyAt({ x: 600.5, y: AIR_FLOOR_Y + 10 + EYE_HEIGHT, z: 600.5 });
    player.vel.x = 3;
    moveAxis({ world, player, axis: 'x', amount: 0.5 });
    expect(player.pos.x).toBeCloseTo(601);
    expect(player.vel.x).toBe(3);
  });

  it('ground-snaps the player onto the floor without falling through', () => {
    const world = new VoxelWorld();
    const floorY = AIR_FLOOR_Y, tileX = 700, tileZ = 700;
    world.set(tileX, floorY, tileZ, GRASS_ID);
    const player = bodyAt({ x: tileX + 0.5, y: floorY + 1 + EYE_HEIGHT + 0.4, z: tileZ + 0.5 });
    player.vel.y = -5;
    moveAxis({ world, player, axis: 'y', amount: -1 });
    expect(player.onGround).toBe(true);
    expect(player.vel.y).toBe(0);
    const feet = player.pos.y - EYE_HEIGHT;
    expect(feet).toBeGreaterThan(floorY + 1);
    expect(collide({ world, pos: player.pos })).toBe(false);
  });

  it('blocks horizontal movement into a wall and zeroes that axis velocity', () => {
    const world = new VoxelWorld();
    const wallY = AIR_FLOOR_Y, wallX = 800, startZ = 800;
    world.set(wallX, wallY, startZ + 1, GRASS_ID);
    const player = bodyAt({ x: wallX + 0.5, y: wallY + EYE_HEIGHT, z: startZ + 0.5 });
    player.vel.z = 4;
    const before = player.pos.z;
    moveAxis({ world, player, axis: 'z', amount: 0.9 });
    expect(player.pos.z).toBe(before);
    expect(player.vel.z).toBe(0);
  });

  it('blocks upward movement into a ceiling and zeroes vertical velocity', () => {
    const world = new VoxelWorld();
    const feetY = AIR_FLOOR_Y, colX = 900, colZ = 900;
    const headBlockY = Math.floor(feetY + PLAYER_HEIGHT) + 1;
    world.set(colX, headBlockY, colZ, GRASS_ID);
    const player = bodyAt({ x: colX + 0.5, y: feetY + EYE_HEIGHT, z: colZ + 0.5 });
    player.vel.y = 5;
    const before = player.pos.y;
    moveAxis({ world, player, axis: 'y', amount: PLAYER_HEIGHT });
    expect(player.pos.y).toBe(before);
    expect(player.vel.y).toBe(0);
    expect(player.onGround).toBe(false);
  });

  it('does not flag onGround when an unobstructed downward move stays in air', () => {
    const world = new VoxelWorld();
    const player = bodyAt({ x: 1000.5, y: AIR_FLOOR_Y + 10 + EYE_HEIGHT, z: 1000.5 });
    player.vel.y = -3;
    moveAxis({ world, player, axis: 'y', amount: -0.5 });
    expect(player.onGround).toBe(false);
    expect(player.vel.y).toBe(-3);
    expect(player.pos.y).toBeCloseTo(AIR_FLOOR_Y + 10 + EYE_HEIGHT - 0.5);
  });

  it('preserves the orthogonal position and velocity when one axis is blocked', () => {
    const world = new VoxelWorld();
    const wallY = AIR_FLOOR_Y, wallX = 1100, startZ = 1100;
    world.set(wallX + 1, wallY, startZ, GRASS_ID);
    const player = bodyAt({ x: wallX + 0.5, y: wallY + EYE_HEIGHT, z: startZ + 0.5 });
    player.vel.x = 4;
    player.vel.z = 2;
    moveAxis({ world, player, axis: 'x', amount: 0.9 });
    expect(player.pos.x).toBe(wallX + 0.5);
    expect(player.vel.x).toBe(0);
    expect(player.vel.z).toBe(2);
    expect(player.pos.z).toBe(startZ + 0.5);
  });
});

describe('water and submerged ground', () => {
  it('lets the player sink through water (water never blocks vertical movement)', () => {
    const world = new VoxelWorld();
    const x = 1150, z = 1150, top = AIR_FLOOR_Y;
    world.set(x, top, z, WATER_ID);
    world.set(x, top - 1, z, WATER_ID);
    const player = bodyAt({ x: x + 0.5, y: top + 0.5 + EYE_HEIGHT, z: z + 0.5 });
    player.vel.y = -6;
    moveAxis({ world, player, axis: 'y', amount: -1 });
    expect(player.onGround).toBe(false);
    expect(player.vel.y).toBe(-6); // unobstructed: velocity preserved
    expect(player.pos.y).toBeCloseTo(top + 0.5 + EYE_HEIGHT - 1);
  });

  it('falls through water and lands on the submerged lakebed', () => {
    const world = new VoxelWorld();
    const x = 1200, z = 1200, bedY = AIR_FLOOR_Y;
    world.set(x, bedY, z, GRASS_ID); // solid lakebed
    world.set(x, bedY + 1, z, WATER_ID); // water column above
    world.set(x, bedY + 2, z, WATER_ID);
    const player = bodyAt({ x: x + 0.5, y: bedY + 2.5 + EYE_HEIGHT, z: z + 0.5 });
    player.vel.y = -8;
    moveAxis({ world, player, axis: 'y', amount: -2 });
    expect(player.onGround).toBe(true);
    expect(player.vel.y).toBe(0);
    const feet = player.pos.y - EYE_HEIGHT;
    expect(feet).toBeGreaterThan(bedY + 1);
    expect(feet).toBeLessThan(bedY + 1.1);
    expect(collide({ world, pos: player.pos })).toBe(false); // standing in water, not stuck
  });

  it('can move horizontally underwater along the lakebed (no stuck-on-floor bug)', () => {
    const world = new VoxelWorld();
    const y = AIR_FLOOR_Y, x = 1250, z0 = 1250;
    for (let d = 0; d < 3; d++) {
      world.set(x, y, z0 + d, GRASS_ID); // lakebed strip
      world.set(x, y + 1, z0 + d, WATER_ID); // water above it
    }
    const player = bodyAt({ x: x + 0.5, y: y + 1 + EYE_HEIGHT + 0.4, z: z0 + 0.5 });
    player.vel.y = -5;
    moveAxis({ world, player, axis: 'y', amount: -1 }); // land on the bed
    expect(player.onGround).toBe(true);
    const zBefore = player.pos.z;
    moveAxis({ world, player, axis: 'z', amount: 0.6 }); // walk forward underwater
    expect(player.pos.z).toBeCloseTo(zBefore + 0.6); // moved, not stuck
  });
});

describe('test region preconditions', () => {
  it('confirms the chosen test region is genuinely air-only terrain', () => {
    const world = new VoxelWorld();
    for (const [x, z] of [[100, 100], [700, 700], [1100, 1100]]) {
      expect(heightAt(x, z)).toBeLessThan(AIR_FLOOR_Y);
      expect(world.isSolid(x, AIR_FLOOR_Y, z)).toBe(false);
    }
  });
});
