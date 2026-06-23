// The pure rule that keeps creatures from stacking: any two whose horizontal (XZ) gap is under
// CREATURE_SEPARATION are shoved directly apart until they just touch, so a crowd spreads out instead
// of piling into one blob. Vertical (y) is owned by the ground clamp, so separation is XZ-only. No
// three.js, no DOM — the Rust server runs the identical pass (room.rs) and the offline AI mirrors it.
import { Vec3 } from './vec3';
import { CREATURE_SEPARATION } from './constants';

// Push every overlapping pair apart in place. Each pair contributes half the correction to each side
// so neither creature is favoured; two on the exact same spot are split along a stable fallback axis
// (the earlier-indexed one goes one way) so the result is deterministic. The array order is the stable
// identity here, mirroring the Rust pass which breaks the same tie by creature id.
export function separateCreatures(creatures: { pos: Vec3 }[]): void {
  for (let i = 0; i < creatures.length; i++) {
    for (let j = i + 1; j < creatures.length; j++) {
      pushApart(creatures[i], creatures[j]);
    }
  }
}

function pushApart(a: { pos: Vec3 }, b: { pos: Vec3 }): void {
  const deltaX = b.pos.x - a.pos.x;
  const deltaZ = b.pos.z - a.pos.z;
  const distance = Math.hypot(deltaX, deltaZ);
  if (distance >= CREATURE_SEPARATION) return;
  const axis = unitAxis({ deltaX, deltaZ, distance });
  const push = (CREATURE_SEPARATION - distance) / 2;
  a.pos.set(a.pos.x - axis.x * push, a.pos.y, a.pos.z - axis.z * push);
  b.pos.set(b.pos.x + axis.x * push, b.pos.y, b.pos.z + axis.z * push);
}

function unitAxis({
  deltaX, deltaZ, distance,
}: {
  deltaX: number;
  deltaZ: number;
  distance: number;
}): { x: number; z: number } {
  if (distance > 0) return { x: deltaX / distance, z: deltaZ / distance };
  return { x: 1, z: 0 };
}
