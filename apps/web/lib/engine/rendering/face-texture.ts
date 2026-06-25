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
    // The cube mesher maps texture-U the same way on every face, and on all four vertical faces that
    // direction points screen-left — so the photo reads horizontally mirrored. Pre-mirror the texture
    // (U -> 1 - U) so it lands the right way round, matching the un-mirrored HUD/lobby preview.
    faceTexture.wrapS = THREE.RepeatWrapping;
    faceTexture.repeat.x = -1;
    faceTexture.offset.x = 1;
    buildMaterials({ materials, faceTexture });
    onReady();
  });
}

export function createCreatureGroup(scene: THREE.Scene): THREE.Group {
  const group = new THREE.Group();
  scene.add(group);
  return group;
}
