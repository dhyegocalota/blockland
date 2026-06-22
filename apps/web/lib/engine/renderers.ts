// Per-frame view rendering (dependency-inverted three.js glue): aims the camera from the player pose and
// repaints the block highlight from the crosshair raycast, then presents the scene. It receives its
// three.js collaborators (camera, highlight, renderer, scene) and the pure look/aim inputs via a typed
// deps object — it never reaches into game-engine. The look math itself is the unit-tested lookDirection
// (aim.ts); this is the glue that pushes it onto the camera.
import * as THREE from 'three';
import { lookDirection } from './aim';
import type { VoxelHit } from './raycast';

export interface ViewRenderer {
  // Aim the camera at the player's eye + look direction and paint the highlight at the aimed cell.
  renderView(args: { pose: { x: number; y: number; z: number; yaw: number; pitch: number }; aim: VoxelHit | null }): void;
  // Draw the scene through the camera.
  present(): void;
}

export function createViewRenderer({
  camera, highlight, renderer, scene,
}: {
  camera: THREE.PerspectiveCamera;
  highlight: THREE.Object3D;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
}): ViewRenderer {
  const lookTarget = new THREE.Vector3();

  function renderView({ pose, aim }: { pose: { x: number; y: number; z: number; yaw: number; pitch: number }; aim: VoxelHit | null }): void {
    camera.position.set(pose.x, pose.y, pose.z);
    const look = lookDirection({ yaw: pose.yaw, pitch: pose.pitch });
    lookTarget.set(camera.position.x + look.x, camera.position.y + look.y, camera.position.z + look.z);
    camera.lookAt(lookTarget);
    if (!aim) { highlight.visible = false; return; }
    highlight.visible = true;
    highlight.position.set(aim.hit[0] + 0.5, aim.hit[1] + 0.5, aim.hit[2] + 0.5);
  }

  function present(): void {
    renderer.render(scene, camera);
  }

  return { renderView, present };
}
