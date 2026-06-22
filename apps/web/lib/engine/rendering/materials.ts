// Three.js material builders: the per-block voxel materials (texture-atlas swatches, with the tenant
// face block swapped for its image texture) and the little face material drawn on creatures. Glue —
// the canvas/texture generation itself is pure (see textures.ts); here we wrap it in THREE materials.
import * as THREE from 'three';
import { FACE_ID } from '../constants';
import { BLOCKS } from '../blocks';
import { ctx2d, makeCanvas, renderBlockCanvas, textureFromCanvas } from '../textures';

// Fill the materials record (keyed by block id) used by the mesher. The tenant face block uses the
// supplied face texture; every other block gets its generated swatch texture.
export function buildMaterials({
  materials,
  faceTexture,
}: {
  materials: Record<number, THREE.MeshLambertMaterial>;
  faceTexture: THREE.Texture;
}): void {
  for (const b of BLOCKS) {
    if (!b) continue;
    let tex: THREE.Texture;
    if (b.id === FACE_ID) tex = faceTexture;
    else { tex = textureFromCanvas(renderBlockCanvas(b)); }
    materials[b.id] = new THREE.MeshLambertMaterial({
      map: tex,
      transparent: !!b.transparent,
      opacity: b.transparent ? 0.78 : 1,
      side: b.transparent ? THREE.DoubleSide : THREE.FrontSide,
    });
  }
}

// A simple smiley face material for creature bodies, tinted to the creature color.
export function makeFaceMaterial(color: string): THREE.MeshLambertMaterial {
  const c = makeCanvas();
  const g = ctx2d(c);
  g.fillStyle = color; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#1a1330';
  g.fillRect(4, 6, 2, 3); g.fillRect(10, 6, 2, 3);
  g.fillRect(6, 11, 4, 1);
  g.fillRect(5, 10, 1, 1); g.fillRect(10, 10, 1, 1);
  return new THREE.MeshLambertMaterial({ map: textureFromCanvas(c) });
}
