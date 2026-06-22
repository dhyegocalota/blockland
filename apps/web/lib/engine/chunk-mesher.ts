// Streaming chunk mesher: turns the voxel world into THREE meshes around the player, one chunk column
// at a time, on a budgeted queue. Owns the mesh-streaming state (the meshed map lives on the shared
// EngineContext; the load queue + last-center bookkeeping is private here). Reads voxels and writes the
// worldGroup through the context so it lives outside game-engine.ts with identical behavior.
//
// The pure pieces it leans on are already unit-tested: meshChunkBuckets (geometry), chunk-grid
// (radius/keep-range math) and mesh-queue (enqueue/sort/dequeue). This module is the THREE glue around
// them and is exercised by e2e.
import * as THREE from 'three';
import { CHUNK, SIZE_X, SIZE_Y, SIZE_Z } from './constants';
import { BLOCKS, blockById } from './blocks';
import { debug } from '../log';
import {
  chunkOutsideKeepRange, chunksInRadius, decodeChunkKey, playerChunk, remeshChunkRange,
} from './chunk-grid';
import { type QueuedChunk, enqueueChunks, shouldMeshDequeued, sortQueueByDistance } from './mesh-queue';
import { meshChunkBuckets } from './meshing';
import type { EngineContext } from './context';

export interface ChunkMesher {
  meshChunk(cxh: number, czh: number): void;
  updateChunks(args: { playerPos: THREE.Vector3; force?: boolean }): void;
  processMeshQueue(budget: number): void;
  remeshRegion(minX: number, maxX: number, minZ: number, maxZ: number): void;
}

export function createChunkMesher(ctx: EngineContext): ChunkMesher {
  const { world, worldGroup, materials, chunkMeshes, chunksX, chunksZ } = ctx;
  const LOAD_R = ctx.isTouch ? 4 : 6;

  const getVoxel = (x: number, y: number, z: number): number => world.get(x, y, z);
  const isTransparent = (id: number): boolean => !!blockById(id)?.transparent;
  const chunkKey = (cx: number, cz: number): number => world.chunkKey(cx, cz);

  let firstChunkStreamed = false;
  let lastPlayerChunkX: number | null = null, lastPlayerChunkZ: number | null = null;
  const meshQueue: QueuedChunk[] = [];
  const queuedKeys = new Set<number>();
  const isMeshed = (key: number): boolean => (chunkMeshes as Map<unknown, THREE.Mesh[]>).has(key);

  function meshChunk(cxh: number, czh: number): void {
    const key = `${cxh},${czh}`;
    const old = chunkMeshes.get(key);
    if (old) old.forEach((m) => { worldGroup.remove(m); m.geometry.dispose(); });

    const x0 = cxh * CHUNK, x1 = Math.min(SIZE_X, x0 + CHUNK);
    const z0 = czh * CHUNK, z1 = Math.min(SIZE_Z, z0 + CHUNK);
    const buckets = meshChunkBuckets({ getVoxel, isTransparent, x0, x1, z0, z1, sizeY: SIZE_Y });

    const meshes: THREE.Mesh[] = [];
    for (const b of BLOCKS) {
      if (!b) continue;
      const data = buckets.get(b.id);
      if (!data) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(data.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(data.norm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
      geo.setIndex(data.idxs);
      const mesh = new THREE.Mesh(geo, materials[b.id]);
      worldGroup.add(mesh);
      meshes.push(mesh);
    }
    chunkMeshes.set(key, meshes);
    if (firstChunkStreamed) return;
    firstChunkStreamed = true;
    debug('engine', 'first chunk streamed', { cx: cxh, cz: czh, meshes: meshes.length });
  }

  function updateChunks({ playerPos, force }: { playerPos: THREE.Vector3; force?: boolean }): void {
    const center = playerChunk(playerPos);
    if (!force && center.cx === lastPlayerChunkX && center.cz === lastPlayerChunkZ) return;
    lastPlayerChunkX = center.cx; lastPlayerChunkZ = center.cz;
    const candidates = chunksInRadius({ center, radius: LOAD_R, chunksX, chunksZ })
      .map(({ cx, cz }) => ({ cx, cz, key: chunkKey(cx, cz) }));
    for (const chunk of enqueueChunks({ candidates, isMeshed, isQueued: (key) => queuedKeys.has(key) })) {
      queuedKeys.add(chunk.key);
      meshQueue.push(chunk);
    }
    sortQueueByDistance({ queue: meshQueue, center });
    for (const [key, meshes] of chunkMeshes) {
      const chunk = decodeChunkKey({ key: Number(key), chunksZ });
      if (!chunkOutsideKeepRange({ chunk, center, radius: LOAD_R })) continue;
      meshes.forEach((m) => { worldGroup.remove(m); m.geometry.dispose(); });
      chunkMeshes.delete(key);
    }
  }

  function processMeshQueue(budget: number): void {
    let done = 0;
    const center = { cx: Number(lastPlayerChunkX), cz: Number(lastPlayerChunkZ) };
    while (done < budget && meshQueue.length) {
      const next = meshQueue.shift();
      if (!next) break;
      queuedKeys.delete(next.key);
      if (!shouldMeshDequeued({ chunk: next, center, radius: LOAD_R, isMeshed })) continue;
      meshChunk(next.cx, next.cz);
      done++;
    }
  }

  function remeshRegion(minX: number, maxX: number, minZ: number, maxZ: number): void {
    const { cx0, cx1, cz0, cz1 } = remeshChunkRange({ minX, maxX, minZ, maxZ, chunksX, chunksZ });
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) meshChunk(cx, cz);
  }

  return { meshChunk, updateChunks, processMeshQueue, remeshRegion };
}
