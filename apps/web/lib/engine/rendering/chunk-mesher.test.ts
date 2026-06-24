import * as THREE from 'three';
import { describe, it, expect, beforeEach } from 'vitest';
import { CHUNK, GRASS_ID, SIZE_X, SIZE_Z } from '../constants';
import { BLOCKS } from '../blocks';
import { VoxelWorld } from '../world';
import { flatWorldgen } from '../test-world';
import { createChunkMesher } from './chunk-mesher';
import type { EngineContext } from '../context';

// A flat grass slab gives the mesher deterministic geometry to build without depending on the real
// procedural worldgen (now the shared Rust source, covered by worldgen-parity.test.ts + the sim golden).
const GROUND_TOP = 12;

function makeContext(isTouch: boolean): EngineContext {
  const materials: Record<number, THREE.MeshLambertMaterial> = {};
  for (const b of BLOCKS) if (b) materials[b.id] = new THREE.MeshLambertMaterial();
  return {
    isTouch,
    scene: new THREE.Scene(),
    worldGroup: new THREE.Group(),
    world: new VoxelWorld(flatWorldgen(GROUND_TOP, GRASS_ID)),
    materials,
    chunkMeshes: new Map<string, THREE.Mesh[]>(),
    chunksX: Math.ceil(SIZE_X / CHUNK),
    chunksZ: Math.ceil(SIZE_Z / CHUNK),
  };
}

const CENTER = new THREE.Vector3(SIZE_X / 2, 40, SIZE_Z / 2);

describe('createChunkMesher', () => {
  let ctx: EngineContext;

  beforeEach(() => {
    ctx = makeContext(false);
  });

  it('meshChunk builds meshes into the world group and records them by string key', () => {
    const mesher = createChunkMesher(ctx);
    mesher.meshChunk(2, 2);
    const meshes = ctx.chunkMeshes.get('2,2');
    expect(meshes).toBeTruthy();
    expect(meshes!.length).toBeGreaterThan(0);
    for (const m of meshes!) expect(ctx.worldGroup.children).toContain(m);
  });

  it('meshChunk replaces a chunk in place, removing the old meshes', () => {
    const mesher = createChunkMesher(ctx);
    mesher.meshChunk(2, 2);
    const first = ctx.chunkMeshes.get('2,2')!;
    mesher.meshChunk(2, 2);
    const second = ctx.chunkMeshes.get('2,2')!;
    expect(second).not.toBe(first);
    for (const m of first) expect(ctx.worldGroup.children).not.toContain(m);
  });

  it('updateChunks queues chunks for later, meshing only on processMeshQueue', () => {
    const mesher = createChunkMesher(ctx);
    const centerCx = Math.floor(CENTER.x / CHUNK), centerCz = Math.floor(CENTER.z / CHUNK);
    mesher.updateChunks({ playerPos: CENTER, force: true });
    expect(ctx.chunkMeshes.has(`${centerCx},${centerCz}`)).toBe(false);
    mesher.processMeshQueue(1);
    expect(ctx.chunkMeshes.has(`${centerCx},${centerCz}`)).toBe(true);
  });

  it('processMeshQueue meshes nearest-first and honors the budget', () => {
    const mesher = createChunkMesher(ctx);
    const centerCx = Math.floor(CENTER.x / CHUNK), centerCz = Math.floor(CENTER.z / CHUNK);
    mesher.updateChunks({ playerPos: CENTER, force: true });
    mesher.processMeshQueue(1);
    expect(ctx.chunkMeshes.size).toBe(1);
    expect(ctx.chunkMeshes.has(`${centerCx},${centerCz}`)).toBe(true);
    mesher.processMeshQueue(4);
    expect(ctx.chunkMeshes.size).toBe(5);
  });

  it('updateChunks does not re-seed the queue when the player stays in the same chunk (unless forced)', () => {
    const mesher = createChunkMesher(ctx);
    // A same-chunk pass enqueues nothing, so the original queue just keeps draining: 3 + 3 = 6, never
    // re-seeded into double-counting.
    mesher.updateChunks({ playerPos: CENTER, force: true });
    mesher.processMeshQueue(3);
    mesher.updateChunks({ playerPos: CENTER });
    mesher.processMeshQueue(3);
    expect(ctx.chunkMeshes.size).toBe(6);
  });

  it('remeshRegion rebuilds the chunk covering the touched cells', () => {
    const mesher = createChunkMesher(ctx);
    mesher.meshChunk(3, 3);
    const before = ctx.chunkMeshes.get('3,3')!;
    mesher.remeshRegion(3 * CHUNK + 1, 3 * CHUNK + 1, 3 * CHUNK + 1, 3 * CHUNK + 1);
    expect(ctx.chunkMeshes.get('3,3')).not.toBe(before);
  });
});
