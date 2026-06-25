// Player-vs-player blocking. Instead of pushing positions (which can drift via interpolated peer
// positions), we cancel the part of the player's velocity that points INTO an overlapping peer.
// This only ever removes motion, so it can never run away: players can slide along or step away
// from each other but cannot walk through. The server stays authoritative for terrain.
import { SIZE_Y } from './constants';

export interface ActorPos {
  x: number;
  y: number;
  z: number;
}

// Returns (vx, vz) with the inward component removed for every actor the player overlaps. `y` and
// each actor's `y` are feet heights; actors more than `height` apart vertically (one flying
// overhead) never block.
export function blockVelocityIntoActors({
  x,
  y,
  z,
  vx,
  vz,
  radius,
  height,
  actors,
  actorRadius,
}: {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  radius: number;
  height: number;
  actors: ActorPos[];
  actorRadius: number;
}): { vx: number; vz: number } {
  let nextVx = vx;
  let nextVz = vz;
  const minDistance = radius + actorRadius;

  for (const actor of actors) {
    if (Math.abs(y - actor.y) >= height) continue;
    const dx = x - actor.x;
    const dz = z - actor.z;
    const distance = Math.hypot(dx, dz);
    if (distance >= minDistance || distance < 1e-6) continue;
    const normalX = dx / distance;
    const normalZ = dz / distance;
    const outward = nextVx * normalX + nextVz * normalZ;
    if (outward < 0) {
      nextVx -= normalX * outward;
      nextVz -= normalZ * outward;
    }
  }

  return { vx: nextVx, vz: nextVz };
}

// True when the voxel cell at (x, y, z) overlaps an actor whose feet sit at (feetX, feetY, feetZ).
// Used to forbid placing a block (or stamping a structure) where a player stands.
export function cellOverlapsActor({
  x,
  y,
  z,
  feetX,
  feetY,
  feetZ,
  radius,
  height,
}: {
  x: number;
  y: number;
  z: number;
  feetX: number;
  feetY: number;
  feetZ: number;
  radius: number;
  height: number;
}): boolean {
  return x + 1 > feetX - radius && x < feetX + radius &&
    z + 1 > feetZ - radius && z < feetZ + radius &&
    y + 1 > feetY && y < feetY + height;
}

// Lift `feet` upward while the actor's two-cell column is blocked, so it ends up standing in clear
// space. Stops just under the world top so it can never run off the column.
// NB: mirrors the Rust room.rs `lift_stuck_players` (whose comment points back here). Extracting a
// shared `sim` fn behind a wasm_api export is a DEFERRED dedup; keep the lift loop in sync by hand.
export function clearFeetAbove({ feet, isSolid }: { feet: number; isSolid: (y: number) => boolean }): number {
  let clear = feet;
  while (clear < SIZE_Y - 2 && (isSolid(clear) || isSolid(clear + 1))) clear++;
  return clear;
}

// Which actors block the player this frame: online it is the remote players + server creatures; offline
// (no coop socket) it is the local creature list — so the player collides with monsters and other
// players in BOTH modes. Pure so the source-selection is unit-tested apart from the loop glue.
export function collisionActors({
  online, coopColliders, coopCreatures, localCreatures,
}: {
  online: boolean;
  coopColliders: ActorPos[];
  coopCreatures: ActorPos[];
  localCreatures: ActorPos[];
}): ActorPos[] {
  if (online) return [...coopColliders, ...coopCreatures];
  return localCreatures;
}
