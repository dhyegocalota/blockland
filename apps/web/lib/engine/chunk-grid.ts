// Chunk streaming math, pure: which chunk the player stands in, which chunks fall inside the load
// radius, how to order them nearest-first, and when a loaded/queued chunk is far enough to evict.
// The three.js mesh building and the Maps stay in the glue; these are numbers only, unit-tested.

import { CHUNK } from './constants';

export interface ChunkCoord {
  cx: number;
  cz: number;
}

export function playerChunk({ x, z }: { x: number; z: number }): ChunkCoord {
  return { cx: Math.floor(x / CHUNK), cz: Math.floor(z / CHUNK) };
}

// Mirrors VoxelWorld.chunkKey's layout so a numeric key can be split back into coordinates for eviction.
export function decodeChunkKey({ key, chunksZ }: { key: number; chunksZ: number }): ChunkCoord {
  return { cx: Math.floor(key / chunksZ), cz: key % chunksZ };
}

// Every in-bounds chunk within `radius` of the player, used to seed the mesh queue.
export function chunksInRadius({
  center, radius, chunksX, chunksZ,
}: {
  center: ChunkCoord;
  radius: number;
  chunksX: number;
  chunksZ: number;
}): ChunkCoord[] {
  const coords: ChunkCoord[] = [];
  for (let dz = -radius; dz <= radius; dz++)
    for (let dx = -radius; dx <= radius; dx++) {
      const cx = center.cx + dx;
      const cz = center.cz + dz;
      if (cx < 0 || cz < 0 || cx >= chunksX || cz >= chunksZ) continue;
      coords.push({ cx, cz });
    }
  return coords;
}

// Nearest-first ordering by squared distance from the player chunk.
export function chunkDistanceSquared({ chunk, center }: { chunk: ChunkCoord; center: ChunkCoord }): number {
  return (chunk.cx - center.cx) ** 2 + (chunk.cz - center.cz) ** 2;
}

export interface ChunkRange {
  cx0: number;
  cx1: number;
  cz0: number;
  cz1: number;
}

// The inclusive chunk range covering a world-space box, clamped to the chunk grid, for a remesh.
export function remeshChunkRange({
  minX, maxX, minZ, maxZ, chunksX, chunksZ,
}: {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  chunksX: number;
  chunksZ: number;
}): ChunkRange {
  return {
    cx0: Math.max(0, Math.floor(minX / CHUNK)),
    cx1: Math.min(chunksX - 1, Math.floor(maxX / CHUNK)),
    cz0: Math.max(0, Math.floor(minZ / CHUNK)),
    cz1: Math.min(chunksZ - 1, Math.floor(maxZ / CHUNK)),
  };
}

// A chunk is evicted (or dropped from the queue) once it sits more than one ring past the load radius.
export function chunkOutsideKeepRange({
  chunk, center, radius,
}: {
  chunk: ChunkCoord;
  center: ChunkCoord;
  radius: number;
}): boolean {
  return Math.abs(chunk.cx - center.cx) > radius + 1 || Math.abs(chunk.cz - center.cz) > radius + 1;
}
