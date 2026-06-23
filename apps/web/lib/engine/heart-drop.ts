// The pure rule behind the HEAL pickup: a defeated creature drops a heart on the ground, and a player
// who walks over it (within HEART_PICKUP_RADIUS) collects it — always, even at full hearts; it only
// heals +1 when below MAX_HEARTS. Drops also expire after HEART_DROP_TTL_MS so they never accumulate.
// No three.js, no DOM — the server mirrors this exact logic in Rust (room.rs).
import { Vec3 } from './vec3';
import {
  HEART_BOB_HEIGHT, HEART_BOB_SPEED, HEART_DROP_TTL_MS, HEART_PICKUP_RADIUS,
} from './constants';

export interface HeartDrop {
  id: number;
  pos: Vec3;
  // Wall-clock ms the drop spawned at; it expires once now - spawnedAt exceeds HEART_DROP_TTL_MS.
  spawnedAt: number;
}

// Whether a player at `playerPos` is close enough to pick up the drop. The pickup happens regardless of
// the player's hearts (a full-hearted player still collects it); the caller heals only when below the cap.
export function canCollectHeart(args: { drop: HeartDrop; playerPos: Vec3 }): boolean {
  return args.playerPos.distanceTo(args.drop.pos) <= HEART_PICKUP_RADIUS;
}

// Whether a drop has outlived its TTL at `now` and should be removed.
export function heartDropExpired(args: { drop: HeartDrop; now: number }): boolean {
  return args.now - args.drop.spawnedAt > HEART_DROP_TTL_MS;
}

// How high a drop hovers above its base position at time `t` (seconds), bobbing gently up and down so
// the pickup reads as a floating heart. Pure so rendering (offline + coop) animates identically.
export function heartBobOffset(t: number): number {
  return HEART_BOB_HEIGHT * Math.sin(t * HEART_BOB_SPEED);
}
