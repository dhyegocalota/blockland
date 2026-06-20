// Closest-sphere ray pick. Pure: a ray (origin + normalized direction) and a list of bounding
// spheres in, the nearest pierced sphere out. Shared by the crosshair picks for creatures and
// remote players. No three.js — callers pass plain numbers and read back the index.
import type { Vec3 } from './physics';

export interface SphereTarget {
  x: number;
  y: number;
  z: number;
  radius: number;
}

// Returns the index and forward distance (`t`) of the nearest target whose bounding sphere the ray
// pierces within `maxDist`, or null when none is hit. Targets behind the origin are ignored.
export function sphereCastClosest({ origin, dir, targets, maxDist }: { origin: Vec3; dir: Vec3; targets: SphereTarget[]; maxDist: number }): { index: number; t: number } | null {
  let bestIndex = -1;
  let bestT = maxDist;
  targets.forEach((target, index) => {
    const ocX = target.x - origin.x;
    const ocY = target.y - origin.y;
    const ocZ = target.z - origin.z;
    const forward = ocX * dir.x + ocY * dir.y + ocZ * dir.z;
    if (forward < 0) return;
    const perpendicularSq = ocX * ocX + ocY * ocY + ocZ * ocZ - forward * forward;
    if (perpendicularSq > target.radius * target.radius) return;
    if (forward >= bestT) return;
    bestT = forward;
    bestIndex = index;
  });
  if (bestIndex < 0) return null;
  return { index: bestIndex, t: bestT };
}
