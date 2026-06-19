// AABB collision against a VoxelWorld plus per-axis movement with ground-snap.
// Pure: operates on plain mutable vectors, no three.js, no DOM.
import { EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_RADIUS } from './constants';
import type { VoxelWorld } from './world';

export type Axis = 'x' | 'y' | 'z';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayerBody {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
}

export function collide({ world, pos }: { world: VoxelWorld; pos: Vec3 }): boolean {
  const minX = Math.floor(pos.x - PLAYER_RADIUS), maxX = Math.floor(pos.x + PLAYER_RADIUS);
  const minZ = Math.floor(pos.z - PLAYER_RADIUS), maxZ = Math.floor(pos.z + PLAYER_RADIUS);
  const feet = pos.y - EYE_HEIGHT;
  const minY = Math.floor(feet), maxY = Math.floor(feet + PLAYER_HEIGHT);
  for (let x = minX; x <= maxX; x++)
    for (let y = minY; y <= maxY; y++)
      for (let z = minZ; z <= maxZ; z++)
        if (world.isSolid(x, y, z)) return true;
  return false;
}

export function moveAxis({ world, player, axis, amount }: { world: VoxelWorld; player: PlayerBody; axis: Axis; amount: number }): void {
  const before = player.pos[axis];
  player.pos[axis] += amount;
  if (!collide({ world, pos: player.pos })) return;
  if (axis === 'y' && amount < 0) {
    const feet = player.pos.y - EYE_HEIGHT;
    player.pos.y = Math.floor(feet) + 1 + EYE_HEIGHT + 1e-3;
    player.onGround = true;
    player.vel.y = 0;
    return;
  }
  player.pos[axis] = before;
  if (axis === 'y') player.vel.y = 0;
  else player.vel[axis] = 0;
}
