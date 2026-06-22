// The three.js object handles the engine threads through its runtime/context contracts. These are the
// genuine GPU/scene-graph objects rendering owns and creates; logic modules only hold references to
// them. Re-exporting the types from this rendering-owned module lets runtime.ts/context.ts `import type`
// them WITHOUT importing three directly, keeping three.js confined to rendering/.
import * as THREE from 'three';
import type {
  BufferGeometry, Group, Mesh, MeshLambertMaterial, PerspectiveCamera, Scene, WebGLRenderer,
} from 'three';

// The three.js module namespace itself, threaded to co-op (which builds remote-player avatars) so the
// logic/composition side never imports three directly to hand it over.
export type GfxModule = typeof THREE;
export const gfx: GfxModule = THREE;

export type GfxScene = Scene;
export type GfxCamera = PerspectiveCamera;
export type GfxRenderer = WebGLRenderer;
export type GfxGroup = Group;
export type GfxChunkMesh = Mesh;
export type GfxMaterial = MeshLambertMaterial;
export type GfxCreatureBody = Mesh<BufferGeometry, MeshLambertMaterial>;
