// The shared mutable handles the engine creates once and threads into the extracted three.js glue
// modules (chunk mesher, etc.). It is the engine's "world of references": the scene graph, the camera,
// the voxel world, the block materials, the per-chunk meshes and the touch flag. Modules read/write
// through this instead of closing over engine-local variables, which is what lets them live outside
// game-engine.ts without changing behavior.
import type { GfxScene, GfxGroup, GfxMaterial, GfxChunkMesh } from './rendering/gfx';
import type { VoxelWorld } from './world';

export interface EngineContext {
  isTouch: boolean;
  scene: GfxScene;
  worldGroup: GfxGroup;
  world: VoxelWorld;
  materials: Record<number, GfxMaterial>;
  chunkMeshes: Map<string, GfxChunkMesh[]>;
  chunksX: number;
  chunksZ: number;
}
