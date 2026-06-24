// PARITY GUARD: the wasm `worldgen_chunk` (the single Rust source, `sim::worldgen_chunk`) must produce
// BYTE-IDENTICAL chunk bases to the TypeScript worldgen this migration DELETED. The deleted algorithm is
// inlined below verbatim (the exact `worldgen.ts` + `VoxelWorld.generateChunk` from origin/main) as the
// frozen reference; if the wasm ever drifts from it, this test fails LOUDLY instead of silently changing
// the terrain. It runs against the REAL built wasm (the gitignore-tracked artifact), instantiated from
// bytes so it works under the node-based vitest. Several chunks: the spawn chunk, the monument chunk, and
// far chunks across varied biomes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AIR, BEDROCK_ID, CHUNK, DIRT_ID, FACE_ID, GOLD_ID, GRASS_ID, GROUND, SAND_ID, SIZE_X, SIZE_Y, SIZE_Z,
  STONE_ID, WATER_ID, WATER_LEVEL, WHITE_ID, WOOD_ID,
} from './constants';

// ---------- The DELETED TypeScript worldgen (frozen reference) ----------
type Biome = 'ocean' | 'beach' | 'plains' | 'forest' | 'desert' | 'savanna' | 'mountains' | 'snow';
const MIN_HEIGHT = 2;
const MAX_HEIGHT = SIZE_Y - 6;
const MONUMENT_X = SIZE_X >> 1;
const MONUMENT_Z = SIZE_Z >> 1;

function continentAt(x: number, z: number): number {
  return Math.sin(x * 0.0008) * 1.0 + Math.cos(z * 0.0009) * 1.0 + Math.sin((x + z) * 0.0005) * 0.8;
}

function heightAt(x: number, z: number): number {
  const continent = continentAt(x, z);
  const hills = Math.sin(x * 0.012) * 1.6 + Math.cos(z * 0.011) * 1.6 + Math.sin((x - z) * 0.008) * 2.2;
  const detail = Math.sin(x * 0.07) * 0.6 + Math.cos(z * 0.063) * 0.6;
  const ridge = Math.sin(x * 0.004) * Math.cos(z * 0.0035);
  const mountains = Math.max(0, continent) * ridge * ridge * 22.0;
  const h = continent * 7.0 + hills + detail + mountains;
  const top = GROUND + Math.round(h);
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, top));
}

function biomeAt(x: number, z: number): Biome {
  const top = heightAt(x, z);
  if (top <= WATER_LEVEL) return 'ocean';
  if (top <= WATER_LEVEL + 1) return 'beach';
  if (top >= GROUND + 16) return 'snow';
  if (top >= GROUND + 10) return 'mountains';
  const temperature = Math.sin(x * 0.0015) * 1.0 + Math.cos(z * 0.0017) * 1.0 + Math.sin((x + z) * 0.0007) * 0.6;
  const humidity = Math.cos(x * 0.0013) * 1.0 + Math.sin(z * 0.0019) * 1.0 + Math.cos((x - z) * 0.0009) * 0.6;
  if (temperature > 1.1 && humidity < 0.0) return 'desert';
  if (temperature > 0.4 && humidity < 0.6) return 'savanna';
  if (humidity > 0.7) return 'forest';
  return 'plains';
}

function surfaceBlock(biome: Biome): number {
  if (biome === 'ocean') return SAND_ID;
  if (biome === 'beach') return SAND_ID;
  if (biome === 'snow') return WHITE_ID;
  if (biome === 'mountains') return STONE_ID;
  if (biome === 'desert') return SAND_ID;
  if (biome === 'savanna') return DIRT_ID;
  return GRASS_ID;
}

function welcomeMonumentBlock(x: number, y: number, z: number): number {
  const dx = x - MONUMENT_X;
  const dz = z - MONUMENT_Z;
  if (dx < -1 || dx > 1 || dz < -1 || dz > 1) return AIR;
  const top = heightAt(MONUMENT_X, MONUMENT_Z);
  if (dx === 0 && dz === 0 && (y === top + 1 || y === top + 2)) return FACE_ID;
  if (y === top + 1 && Math.abs(dx) + Math.abs(dz) === 1) return GOLD_ID;
  return AIR;
}

function baseVoxel(x: number, y: number, z: number): number {
  const monument = welcomeMonumentBlock(x, y, z);
  if (monument !== AIR) return monument;
  const top = heightAt(x, z);
  if (y > top) return y <= WATER_LEVEL ? WATER_ID : AIR;
  if (y === 0) return BEDROCK_ID;
  if (y === top) return surfaceBlock(biomeAt(x, z));
  if (y >= top - 2) return DIRT_ID;
  return STONE_ID;
}

function chunkSeed(cx: number, cz: number): number {
  return (Math.imul(cx, 374761393) ^ Math.imul(cz, 668265263) ^ 0x9e3779b9) >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The frozen `VoxelWorld.generateChunk`/`decorateChunk`/`placeTree` body: fill a chunk's base into a
// flat array in the `lx + lz*CHUNK + y*CHUNK*CHUNK` layout, exactly as origin/main did.
function oldGenerateChunk(cx: number, cz: number): Uint8Array {
  const volume = CHUNK * CHUNK * SIZE_Y;
  const arr = new Uint8Array(volume);
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const idx = (lx: number, y: number, lz: number): number => lx + lz * CHUNK + y * CHUNK * CHUNK;
  const inChunk = (x: number, z: number): boolean => x >= x0 && x < x0 + CHUNK && z >= z0 && z < z0 + CHUNK;
  const rawSet = (x: number, y: number, z: number, id: number): void => {
    if (!inChunk(x, z) || y < 0 || y >= SIZE_Y) return;
    arr[idx(x - x0, y, z - z0)] = id;
  };
  const rawGet = (x: number, y: number, z: number): number => {
    if (!inChunk(x, z) || y < 0 || y >= SIZE_Y) return AIR;
    return arr[idx(x - x0, y, z - z0)];
  };
  const placeTree = (x: number, top: number, z: number, biome: Biome, rng: () => number): void => {
    const trunk = 3 + Math.floor(rng() * 3);
    for (let t = 1; t <= trunk; t++) rawSet(x, top + t, z, WOOD_ID);
    const leaf = biome === 'snow' ? 12 : 5;
    const cy = top + trunk;
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++)
        for (let dy = 0; dy <= 2; dy++) {
          const lx = x + dx, lz = z + dz;
          if (lx < x0 || lx >= x0 + CHUNK || lz < z0 || lz >= z0 + CHUNK) continue;
          if (Math.abs(dx) + Math.abs(dz) + dy > 3) continue;
          if (rawGet(lx, cy + dy, lz) === AIR) rawSet(lx, cy + dy, lz, leaf);
        }
  };

  for (let x = x0; x < x0 + CHUNK && x < SIZE_X; x++)
    for (let z = z0; z < z0 + CHUNK && z < SIZE_Z; z++) {
      const top = heightAt(x, z);
      for (let y = 0; y <= top; y++) rawSet(x, y, z, baseVoxel(x, y, z));
      for (let y = top + 1; y <= WATER_LEVEL; y++) rawSet(x, y, z, WATER_ID);
      for (let y = top + 1; y < SIZE_Y; y++) {
        const monument = welcomeMonumentBlock(x, y, z);
        if (monument !== AIR) rawSet(x, y, z, monument);
      }
    }

  const rng = mulberry32(chunkSeed(cx, cz));
  for (let i = 0; i < 30; i++) {
    const x = x0 + 2 + Math.floor(rng() * (CHUNK - 4));
    const z = z0 + 2 + Math.floor(rng() * (CHUNK - 4));
    const top = heightAt(x, z);
    if (top <= WATER_LEVEL) continue;
    const biome = biomeAt(x, z);
    const density = biome === 'forest' ? 0.75 : biome === 'plains' ? 0.22 : biome === 'snow' ? 0.16 : 0.02;
    if (rng() < density) { placeTree(x, top, z, biome, rng); continue; }
    if (biome !== 'desert' && rng() < 0.1 && rawGet(x, top + 1, z) === AIR) rawSet(x, top + 1, z, 9);
  }
  for (const [chance, id] of [[0.5, 8], [0.28, 14], [0.08, 15]] as const) {
    if (rng() >= chance) continue;
    const x = x0 + Math.floor(rng() * CHUNK);
    const z = z0 + Math.floor(rng() * CHUNK);
    const top = heightAt(x, z);
    if (top > WATER_LEVEL && rawGet(x, top + 1, z) === AIR) rawSet(x, top + 1, z, id);
  }
  return arr;
}

// ---------- The wasm under test ----------
interface WasmModule {
  default(bytes: BufferSource): Promise<unknown>;
  worldgen_chunk(cx: number, cz: number): Uint8Array;
}

let wasm: WasmModule;

beforeAll(async () => {
  const mod = (await import('../wasm/game_core_wasm.js')) as unknown as WasmModule;
  const bytes = readFileSync(fileURLToPath(new URL('../wasm/game_core_wasm_bg.wasm', import.meta.url)));
  await mod.default(bytes);
  wasm = mod;
});

describe('wasm worldgen_chunk parity with the deleted TS worldgen', () => {
  // Spawn chunk, the world-centre monument chunk, and far chunks across varied biomes.
  const MONUMENT_CHUNK = (SIZE_X >> 1) / CHUNK;
  const chunks: Array<[number, number]> = [
    [0, 0],
    [MONUMENT_CHUNK, MONUMENT_CHUNK],
    [5, 7],
    [50, 13],
    [120, 200],
    [3, 999],
  ];

  it.each(chunks)('chunk (%i, %i) is byte-identical', (cx, cz) => {
    const fromWasm = wasm.worldgen_chunk(cx, cz);
    const fromOldTs = oldGenerateChunk(cx, cz);
    expect(fromWasm.length).toBe(fromOldTs.length);
    expect(fromWasm).toEqual(fromOldTs);
  });

  it('the monument chunk actually contains the welcome monument (the comparison is meaningful)', () => {
    const fromWasm = wasm.worldgen_chunk(MONUMENT_CHUNK, MONUMENT_CHUNK);
    expect(fromWasm).toContain(FACE_ID);
    expect(fromWasm).toContain(GOLD_ID);
  });
});
