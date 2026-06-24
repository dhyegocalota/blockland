// Test fixtures for the voxel store: a fake `WorldgenChunk` and a `VoxelWorld` built on it. The store's
// job is caching a chunk's procedural base + overlaying edits — NOT computing terrain (that's the shared
// Rust worldgen, proven byte-identical by `worldgen-parity.test.ts` and the `sim` golden test). So the
// store's own tests run on a simple, predictable fake instead of the real wasm.
import { CHUNK, SIZE_Y } from './constants';
import { VoxelWorld } from './world';
import type { WorldgenChunk } from './online/wasm-core-loader';

const CHUNK_VOLUME = CHUNK * CHUNK * SIZE_Y;

export function localIndex(lx: number, y: number, lz: number): number {
  return lx + lz * CHUNK + y * CHUNK * CHUNK;
}

// A worldgen whose voxel at every cell is a deterministic function of its WORLD coordinates, so the store
// tests can predict exactly what a cached chunk should read back. `fill(x, y, z) => id`.
export function fakeWorldgen(fill: (x: number, y: number, z: number) => number): WorldgenChunk {
  return (cx, cz) => {
    const arr = new Uint8Array(CHUNK_VOLUME);
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    for (let lx = 0; lx < CHUNK; lx++)
      for (let lz = 0; lz < CHUNK; lz++)
        for (let y = 0; y < SIZE_Y; y++)
          arr[localIndex(lx, y, lz)] = fill(x0 + lx, y, z0 + lz);
    return arr;
  };
}

// A worldgen that fills nothing (all AIR): the default for store/physics/raycast/mesher tests that place
// their own blocks by hand and never depend on procedural terrain.
export const emptyWorldgen: WorldgenChunk = fakeWorldgen(() => 0);

// A flat grass slab from bedrock to `top` (inclusive): a predictable, solid base so the mesher has
// geometry to build without depending on the real procedural algorithm.
export function flatWorldgen(top: number, grassId: number): WorldgenChunk {
  return fakeWorldgen((_x, y) => (y <= top ? grassId : 0));
}

export function makeTestWorld(worldgen: WorldgenChunk = emptyWorldgen): VoxelWorld {
  return new VoxelWorld(worldgen);
}
