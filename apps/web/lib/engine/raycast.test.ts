import { describe, expect, it } from 'vitest';
import { WATER_ID } from './constants';
import type { Vec3 } from './physics';
import { VoxelWorld } from './world';
import { raycastVoxel } from './raycast';

function normalize({ x, y, z }: Vec3): Vec3 {
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
}

const SOLID = 3;
// Test at an elevation above any procedural terrain (terrain tops out at SIZE_Y - 6), so these
// pure raycast cases see empty air except for the blocks they place themselves.
const Y = 45;

describe('raycastVoxel', () => {
  it('returns null when nothing is hit within range', () => {
    const world = new VoxelWorld();
    const hit = raycastVoxel({ world, origin: { x: 4, y: Y + 2, z: 4 }, dir: normalize({ x: 0.01, y: 1, z: 0.01 }), maxDist: 1.5 });
    expect(hit).toBeNull();
  });

  it('returns null when the ray flies off into open air', () => {
    const world = new VoxelWorld();
    const hit = raycastVoxel({ world, origin: { x: 4.5, y: Y + 2, z: 4.5 }, dir: normalize({ x: 0, y: 1, z: 0 }), maxDist: 1.5 });
    expect(hit).toBeNull();
  });

  it('hits a solid block and reports the placement face toward the ray origin', () => {
    const world = new VoxelWorld();
    world.set(4, Y, 4, SOLID);
    const hit = raycastVoxel({ world, origin: { x: 4.5, y: Y + 5, z: 4.5 }, dir: normalize({ x: 0.01, y: -1, z: 0.01 }), maxDist: 10 });
    expect(hit).not.toBeNull();
    expect(hit!.hit).toEqual([4, Y, 4]);
    expect(hit!.place).toEqual([4, Y + 1, 4]);
  });

  it('returns the origin cell itself when the ray starts inside a solid block', () => {
    const world = new VoxelWorld();
    world.set(4, Y, 4, SOLID);
    const hit = raycastVoxel({ world, origin: { x: 4.5, y: Y + 0.5, z: 4.5 }, dir: normalize({ x: 1, y: 0, z: 0 }), maxDist: 5 });
    expect(hit!.hit).toEqual([4, Y, 4]);
    expect(hit!.place).toEqual([4, Y, 4]);
  });

  it('walks along the +x axis and places on the near face', () => {
    const world = new VoxelWorld();
    world.set(8, Y, 4, SOLID);
    const hit = raycastVoxel({ world, origin: { x: 1.5, y: Y + 0.5, z: 4.5 }, dir: normalize({ x: 1, y: 0.01, z: 0.01 }), maxDist: 12 });
    expect(hit!.hit).toEqual([8, Y, 4]);
    expect(hit!.place).toEqual([7, Y, 4]);
  });

  it('walks along the -x axis and places on the opposite near face', () => {
    const world = new VoxelWorld();
    world.set(2, Y, 4, SOLID);
    const hit = raycastVoxel({ world, origin: { x: 9.5, y: Y + 0.5, z: 4.5 }, dir: normalize({ x: -1, y: 0.01, z: 0.01 }), maxDist: 12 });
    expect(hit!.hit).toEqual([2, Y, 4]);
    expect(hit!.place).toEqual([3, Y, 4]);
  });

  it('walks along the +z axis and places on the near face', () => {
    const world = new VoxelWorld();
    world.set(4, Y, 8, SOLID);
    const hit = raycastVoxel({ world, origin: { x: 4.5, y: Y + 0.5, z: 1.5 }, dir: normalize({ x: 0.01, y: 0.01, z: 1 }), maxDist: 12 });
    expect(hit!.hit).toEqual([4, Y, 8]);
    expect(hit!.place).toEqual([4, Y, 7]);
  });

  it('walks straight down and places on the top face', () => {
    const world = new VoxelWorld();
    world.set(4, Y - 2, 4, SOLID);
    const hit = raycastVoxel({ world, origin: { x: 4.5, y: Y + 5, z: 4.5 }, dir: normalize({ x: 0.01, y: -1, z: 0.01 }), maxDist: 12 });
    expect(hit!.hit).toEqual([4, Y - 2, 4]);
    expect(hit!.place).toEqual([4, Y - 1, 4]);
  });

  it('respects maxDist: a block just beyond range is not hit', () => {
    const world = new VoxelWorld();
    world.set(10, Y, 4, SOLID);
    const dir = normalize({ x: 1, y: 0.001, z: 0.001 });
    expect(raycastVoxel({ world, origin: { x: 4.5, y: Y + 0.5, z: 4.5 }, dir, maxDist: 3 })).toBeNull();
  });

  it('respects maxDist: the same block within range is hit', () => {
    const world = new VoxelWorld();
    world.set(10, Y, 4, SOLID);
    const dir = normalize({ x: 1, y: 0.001, z: 0.001 });
    const hit = raycastVoxel({ world, origin: { x: 4.5, y: Y + 0.5, z: 4.5 }, dir, maxDist: 8 });
    expect(hit!.hit).toEqual([10, Y, 4]);
    expect(hit!.place).toEqual([9, Y, 4]);
  });

  it('passes through water (non-solid) and hits the solid block behind it', () => {
    const world = new VoxelWorld();
    world.set(4, Y, 4, WATER_ID);
    world.set(4, Y - 3, 4, SOLID);
    const hit = raycastVoxel({ world, origin: { x: 4.5, y: Y + 5, z: 4.5 }, dir: normalize({ x: 0.01, y: -1, z: 0.01 }), maxDist: 12 });
    expect(hit!.hit).toEqual([4, Y - 3, 4]);
    expect(hit!.place).toEqual([4, Y - 2, 4]);
  });

  it('stops at the nearest solid block along the ray', () => {
    const world = new VoxelWorld();
    world.set(6, Y, 4, SOLID);
    world.set(9, Y, 4, SOLID);
    const hit = raycastVoxel({ world, origin: { x: 1.5, y: Y + 0.5, z: 4.5 }, dir: normalize({ x: 1, y: 0.01, z: 0.01 }), maxDist: 12 });
    expect(hit!.hit).toEqual([6, Y, 4]);
  });
});
