// Pure procedural terrain: deterministic height, biome, and base voxel per coordinate.
// No three.js, no DOM, no randomness — random decoration lives in the world generator glue.
//
// The math here is mirrored bit-for-bit in the Rust server (apps/server/crates/sim/src/lib.rs):
// same f64 operations, same literal constants, same order. The shared golden vectors pin them
// together. Change one side and you MUST change the other identically.
import {
  AIR, BEDROCK_ID, DIRT_ID, FACE_ID, GOLD_ID, GRASS_ID, GROUND, SAND_ID, SIZE_X, SIZE_Y, SIZE_Z,
  STONE_ID, WATER_ID, WATER_LEVEL, WHITE_ID,
} from './constants';

export type Biome =
  | 'ocean'
  | 'beach'
  | 'plains'
  | 'forest'
  | 'desert'
  | 'savanna'
  | 'mountains'
  | 'snow';

// Final terrain top is clamped into this band so it always fits inside the column with headroom.
const MIN_HEIGHT = 2;
const MAX_HEIGHT = SIZE_Y - 6;

// Layered deterministic "noise": a low-frequency continent/ocean signal, mid-frequency hills, a
// high-frequency detail ripple, and squared ridges that only bite in high-continent areas.
function continentAt(x: number, z: number): number {
  return Math.sin(x * 0.0008) * 1.0 + Math.cos(z * 0.0009) * 1.0
    + Math.sin((x + z) * 0.0005) * 0.8;
}

export function heightAt(x: number, z: number): number {
  const continent = continentAt(x, z);
  const hills = Math.sin(x * 0.012) * 1.6 + Math.cos(z * 0.011) * 1.6
    + Math.sin((x - z) * 0.008) * 2.2;
  const detail = Math.sin(x * 0.07) * 0.6 + Math.cos(z * 0.063) * 0.6;
  const ridge = Math.sin(x * 0.004) * Math.cos(z * 0.0035);
  const mountains = Math.max(0, continent) * ridge * ridge * 22.0;
  const h = continent * 7.0 + hills + detail + mountains;
  const top = GROUND + Math.round(h);
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, top));
}

export function biomeAt(x: number, z: number): Biome {
  const top = heightAt(x, z);
  if (top <= WATER_LEVEL) return 'ocean';
  if (top <= WATER_LEVEL + 1) return 'beach';
  if (top >= GROUND + 16) return 'snow';
  if (top >= GROUND + 10) return 'mountains';
  const temperature = Math.sin(x * 0.0015) * 1.0 + Math.cos(z * 0.0017) * 1.0
    + Math.sin((x + z) * 0.0007) * 0.6;
  const humidity = Math.cos(x * 0.0013) * 1.0 + Math.sin(z * 0.0019) * 1.0
    + Math.cos((x - z) * 0.0009) * 0.6;
  if (temperature > 1.1 && humidity < 0.0) return 'desert';
  if (temperature > 0.4 && humidity < 0.6) return 'savanna';
  if (humidity > 0.7) return 'forest';
  return 'plains';
}

export function surfaceBlock(biome: Biome): number {
  if (biome === 'ocean') return SAND_ID;
  if (biome === 'beach') return SAND_ID;
  if (biome === 'snow') return WHITE_ID;
  if (biome === 'mountains') return STONE_ID;
  if (biome === 'desert') return SAND_ID;
  if (biome === 'savanna') return DIRT_ID;
  return GRASS_ID;
}

// The welcome monument, folded into the shared worldgen so the server's authoritative world
// contains it (diggable via the normal edit path, visible to creatures) and the client renders the
// same generation — no client-side stamp. A two-cell-tall tenant face on a four-cell gold cross,
// centred on the world. Mirrored bit-for-bit by `welcome_monument_block` in the Rust sim.
const MONUMENT_X = SIZE_X >> 1;
const MONUMENT_Z = SIZE_Z >> 1;

export function welcomeMonumentBlock(x: number, y: number, z: number): number {
  const dx = x - MONUMENT_X;
  const dz = z - MONUMENT_Z;
  if (dx < -1 || dx > 1 || dz < -1 || dz > 1) return AIR;
  const top = heightAt(MONUMENT_X, MONUMENT_Z);
  if (dx === 0 && dz === 0 && (y === top + 1 || y === top + 2)) return FACE_ID;
  if (y === top + 1 && Math.abs(dx) + Math.abs(dz) === 1) return GOLD_ID;
  return AIR;
}

export function baseVoxel(x: number, y: number, z: number): number {
  const monument = welcomeMonumentBlock(x, y, z);
  if (monument !== AIR) return monument;
  const top = heightAt(x, z);
  if (y > top) return y <= WATER_LEVEL ? WATER_ID : AIR;
  if (y === 0) return BEDROCK_ID;
  if (y === top) return surfaceBlock(biomeAt(x, z));
  if (y >= top - 2) return DIRT_ID;
  return STONE_ID;
}
