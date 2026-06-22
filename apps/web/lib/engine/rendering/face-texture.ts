// Three.js boot texture glue the builder composes rather than constructing itself: loads the tenant
// face image, configures it for crisp pixel art (nearest filter, sRGB) and fills the block materials
// off it. The async load returns control through onReady once the materials are ready.
import * as THREE from 'three';
import { buildMaterials } from './materials';

export function loadFaceTexture({
  url,
  materials,
  cancelled,
  onReady,
}: {
  url: string;
  materials: Record<number, THREE.MeshLambertMaterial>;
  cancelled: () => boolean;
  onReady: () => void;
}): void {
  new THREE.TextureLoader().load(url, (faceTexture) => {
    if (cancelled()) return;
    faceTexture.magFilter = THREE.NearestFilter;
    faceTexture.colorSpace = THREE.SRGBColorSpace;
    buildMaterials({ materials, faceTexture });
    onReady();
  });
}

export function createCreatureGroup(scene: THREE.Scene): THREE.Group {
  const group = new THREE.Group();
  scene.add(group);
  return group;
}
