// Pure procedural terrain: deterministic height, biome, and base voxel per coordinate.
// No three.js, no DOM, no randomness — random decoration lives in the world generator glue.
import { AIR, BEDROCK_ID, GROUND, SIZE_Y, WATER_ID, WATER_LEVEL } from './constants';

export type Biome = 'desert' | 'plains' | 'forest' | 'snow';

export function heightAt(x: number, z: number): number {
  const h = Math.sin(x * 0.05) * 1.4 + Math.cos(z * 0.045) * 1.4
    + Math.sin((x + z) * 0.02) * 2.6
    + Math.sin(x * 0.013) * Math.cos(z * 0.017) * 4.2;
  return Math.max(2, Math.min(SIZE_Y - 5, GROUND + Math.round(h)));
}

export function biomeAt(x: number, z: number): Biome {
  const v = Math.sin(x * 0.0125) * 1.2 + Math.cos(z * 0.011) * 1.2 + Math.sin((x - z) * 0.006) * 1.4;
  if (v < -1.1) return 'desert';
  if (v < 0.2) return 'plains';
  if (v < 1.3) return 'forest';
  return 'snow';
}

export function surfaceBlock(biome: Biome, top: number): number {
  if (top <= WATER_LEVEL + 1) return 6;                       // sandy shore
  if (top >= GROUND + 7) return top >= GROUND + 9 ? 12 : 3;   // mountain rock + snowy peak
  if (biome === 'desert') return 6;
  if (biome === 'snow') return 12;
  return 1;
}

export function baseVoxel(x: number, y: number, z: number): number {
  const top = heightAt(x, z);
  if (y > top) return y <= WATER_LEVEL ? WATER_ID : AIR;
  if (y === 0) return BEDROCK_ID;
  if (y === top) return surfaceBlock(biomeAt(x, z), top);
  if (y >= top - 2) return 2;
  return 3;
}
