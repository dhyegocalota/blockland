// Player-vs-player blocking. Instead of pushing positions (which can drift via interpolated peer
// positions), we cancel the part of the player's velocity that points INTO an overlapping peer.
// This only ever removes motion, so it can never run away: players can slide along or step away
// from each other but cannot walk through. The server stays authoritative for terrain.

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
