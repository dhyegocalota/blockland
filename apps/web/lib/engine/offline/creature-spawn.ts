// Single-player creature spawning, pure: where a new creature appears (a random spot within range of
// the world centre, kept off the edge) and the starting roster. The three.js mesh and ground sampling
// stay in the glue; the placement and the roster are data/numbers here, unit-tested.

export const SPAWN_RANGE = 80;
const EDGE_MARGIN = 2;

// The starting population the single-player sandbox seeds the world with.
export const STARTING_ROSTER: string[] = [
  'pig', 'pig', 'pig',
  'chicken', 'chicken',
  'cow', 'cow',
  'slime', 'slime',
  'spider',
];

export function spawnPosition({
  sizeX, sizeZ, random,
}: {
  sizeX: number;
  sizeZ: number;
  random: () => number;
}): { x: number; z: number } {
  const centerX = sizeX / 2;
  const centerZ = sizeZ / 2;
  return {
    x: clampInside({ value: centerX + (random() - 0.5) * 2 * SPAWN_RANGE, max: sizeX }),
    z: clampInside({ value: centerZ + (random() - 0.5) * 2 * SPAWN_RANGE, max: sizeZ }),
  };
}

function clampInside({ value, max }: { value: number; max: number }): number {
  return Math.max(EDGE_MARGIN, Math.min(max - EDGE_MARGIN, value));
}
