// The pure spiral that nudges a spawn to the nearest empty slot. Starting from the base column it
// walks outward ring by ring (Chebyshev radius 0, 1, 2, …) and returns the first column where
// `isClear` is true; if nothing within `maxRadius` is clear it falls back to the base. No three.js,
// no DOM — the Rust server runs the identical ring order (room.rs `find_spawn_slot`) so the online
// truth and the offline prediction agree on which slot a blocked spawn snaps to.

// A column is a clear spawn slot when its body — the two cells just above the surface, where the
// player stands — is not solid (so the player never lands inside terrain, the monument or a built
// block) AND no creature or other player is within `clearanceGap` horizontally (so the player never
// materialises on top of a monster or another player). The feet land at surface + 1. Mirrors the Rust
// `spawn_column_clear` so online truth and offline prediction agree.
export function spawnColumnClear({
  x, z, clearanceGap, surfaceY, isSolid, actors,
}: {
  x: number;
  z: number;
  clearanceGap: number;
  surfaceY: (x: number, z: number) => number;
  isSolid: (x: number, y: number, z: number) => boolean;
  actors: Array<{ x: number; z: number }>;
}): boolean {
  const surface = surfaceY(x, z);
  if (isSolid(x, surface + 1, z) || isSolid(x, surface + 2, z)) return false;
  const columnX = x + 0.5;
  const columnZ = z + 0.5;
  return !actors.some((actor) => Math.hypot(actor.x - columnX, actor.z - columnZ) < clearanceGap);
}

// Pick a random base spawn column within `radius` of the centre column, given an injected `random()`
// returning `[0, 1)` (one draw per axis). The slot search then starts here, so each spawn lands
// scattered around the monument instead of always on the exact centre while still resolving to a clear
// column. The `random` fn is injected so tests stay deterministic. Mirrors the Rust `random_spawn_base`.
export function randomSpawnBase({
  centerX, centerZ, radius, random,
}: {
  centerX: number;
  centerZ: number;
  radius: number;
  random: () => number;
}): { x: number; z: number } {
  const span = radius * 2 + 1;
  const offsetX = Math.floor(random() * span) - radius;
  const offsetZ = Math.floor(random() * span) - radius;
  return { x: centerX + offsetX, z: centerZ + offsetZ };
}

// Ring r visits its perimeter in a fixed order: each row dz from -r..=r, and within a row the two
// edge columns dx = -r and dx = r (the top/bottom rows scan every dx from -r..=r). This exact order
// is mirrored in Rust so both sides pick the same column for the same world.
export function findSpawnSlot({
  baseX, baseZ, maxRadius, isClear,
}: {
  baseX: number;
  baseZ: number;
  maxRadius: number;
  isClear: (x: number, z: number) => boolean;
}): { x: number; z: number } {
  for (let radius = 0; radius <= maxRadius; radius++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const onEdgeRow = dz === -radius || dz === radius;
      for (let dx = -radius; dx <= radius; dx++) {
        if (!onEdgeRow && dx !== -radius && dx !== radius) continue;
        const x = baseX + dx;
        const z = baseZ + dz;
        if (isClear(x, z)) return { x, z };
      }
    }
  }
  return { x: baseX, z: baseZ };
}
