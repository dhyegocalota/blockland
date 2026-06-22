// The three.js object handles the engine threads through its runtime/context contracts. These are the
// genuine GPU/scene-graph objects rendering owns and creates; logic modules only hold references to
// them. Re-exporting the types from this rendering-owned module lets runtime.ts/context.ts `import type`
// them WITHOUT importing three directly, keeping three.js confined to rendering/.
import type {
  BufferGeometry, Group, Mesh, MeshLambertMaterial, PerspectiveCamera, Scene, WebGLRenderer,
} from 'three';

export type GfxScene = Scene;
export type GfxCamera = PerspectiveCamera;
export type GfxRenderer = WebGLRenderer;
export type GfxGroup = Group;
export type GfxChunkMesh = Mesh;
export type GfxMaterial = MeshLambertMaterial;
export type GfxCreatureBody = Mesh<BufferGeometry, MeshLambertMaterial>;
