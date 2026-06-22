// Single-player creature combat + animation math, pure: the bob bounce as a creature walks, whether a
// hostile creature is close enough to bite the player, and the knockback shove a hit gives it. The
// three.js meshes and audio stay in the glue; these are numbers only, unit-tested.

export const HIT_RANGE = 1.0;
export const HIT_VERTICAL_GAP = 1.6;
export const KNOCKBACK_DISTANCE = 1.2;
export const FLASH_TIME = 0.18;
const BOB_HEIGHT = 0.12;

const EDGE_MARGIN = 1;

// Vertical bounce added on top of the creature's standing height as it walks.
export function bobOffset(bob: number): number {
  return Math.abs(Math.sin(bob)) * BOB_HEIGHT;
}

// Advances a wandering creature along its facing for one tick, clamped inside the world edges.
export function stepCreaturePosition({
  x, z, dir, speed, dt, sizeX, sizeZ,
}: {
  x: number;
  z: number;
  dir: number;
  speed: number;
  dt: number;
  sizeX: number;
  sizeZ: number;
}): { x: number; z: number } {
  return {
    x: clampEdge({ value: x + Math.sin(dir) * speed * dt, max: sizeX }),
    z: clampEdge({ value: z + Math.cos(dir) * speed * dt, max: sizeZ }),
  };
}

function clampEdge({ value, max }: { value: number; max: number }): number {
  return Math.max(EDGE_MARGIN, Math.min(max - EDGE_MARGIN, value));
}

// A hostile creature bites only when it is both close on the ground and at the player's level.
export function creatureBitesPlayer({
  horizontalDistance, verticalGap,
}: {
  horizontalDistance: number;
  verticalGap: number;
}): boolean {
  return horizontalDistance < HIT_RANGE && verticalGap < HIT_VERTICAL_GAP;
}

// The shove away from the player when a creature is hit (zero when overlapping exactly).
export function knockbackVector({
  creatureX, creatureZ, playerX, playerZ,
}: {
  creatureX: number;
  creatureZ: number;
  playerX: number;
  playerZ: number;
}): { x: number; z: number } {
  const dx = creatureX - playerX;
  const dz = creatureZ - playerZ;
  const length = Math.hypot(dx, dz);
  if (length === 0) return { x: 0, z: 0 };
  return { x: (dx / length) * KNOCKBACK_DISTANCE, z: (dz / length) * KNOCKBACK_DISTANCE };
}
