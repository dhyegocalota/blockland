// DDA voxel raycast against a VoxelWorld. Pure: plain vectors in, plain hit out.
import type { Vec3 } from './physics';
import type { VoxelWorld } from './world';

export interface VoxelHit {
  hit: [number, number, number];
  place: [number, number, number];
}

export function raycastVoxel({ world, origin, dir, maxDist }: { world: VoxelWorld; origin: Vec3; dir: Vec3; maxDist: number }): VoxelHit | null {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const step = [Math.sign(dir.x), Math.sign(dir.y), Math.sign(dir.z)];
  const tDelta = [Math.abs(1 / dir.x), Math.abs(1 / dir.y), Math.abs(1 / dir.z)];
  const tMax = [
    step[0] > 0 ? (x + 1 - origin.x) / dir.x : (origin.x - x) / -dir.x,
    step[1] > 0 ? (y + 1 - origin.y) / dir.y : (origin.y - y) / -dir.y,
    step[2] > 0 ? (z + 1 - origin.z) / dir.z : (origin.z - z) / -dir.z,
  ];
  let face = [0, 0, 0];
  for (let i = 0; i < maxDist * 3; i++) {
    if (world.isSolid(x, y, z)) return { hit: [x, y, z], place: [x + face[0], y + face[1], z + face[2]] };
    if (tMax[0] < tMax[1] && tMax[0] < tMax[2]) { x += step[0]; if (tMax[0] > maxDist) break; tMax[0] += tDelta[0]; face = [-step[0], 0, 0]; }
    else if (tMax[1] < tMax[2]) { y += step[1]; if (tMax[1] > maxDist) break; tMax[1] += tDelta[1]; face = [0, -step[1], 0]; }
    else { z += step[2]; if (tMax[2] > maxDist) break; tMax[2] += tDelta[2]; face = [0, 0, -step[2]]; }
  }
  return null;
}
