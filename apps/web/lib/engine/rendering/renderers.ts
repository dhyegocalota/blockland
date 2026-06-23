// Per-frame view rendering (dependency-inverted three.js glue): aims the camera from the player pose and
// repaints the block highlight from the crosshair raycast, then presents the scene. It receives its
// three.js collaborators (camera, highlight, renderer, scene) and the pure look/aim inputs via a typed
// deps object — it never reaches into game-engine. The look math itself is the unit-tested lookDirection
// (aim.ts); this is the glue that pushes it onto the camera. It also owns the first-person held tool: a
// small blocky arm in front of the camera that swings on every attack, driven by the pure swingPose.
import * as THREE from 'three';
import { lookDirection } from '../aim';
import { SWING_DURATION_MS, SWING_PEAK_RAD } from '../constants';
import { swingPose } from '../swing';
import type { VoxelHit } from '../raycast';

const HAND_COLOR = '#caa472';
const HAND_REST_ROTATION_X = -0.5;

export interface ViewRenderer {
  // Aim the camera at the player's eye + look direction and paint the highlight at the aimed cell.
  renderView(args: { pose: { x: number; y: number; z: number; yaw: number; pitch: number }; aim: VoxelHit | null }): void;
  // Start a fresh swing of the first-person held tool (called on every primary action).
  swing(now?: number): void;
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

  // The held tool hangs off a pivot at its top end so a rotation swings the whole block forward like a
  // hand chopping down. The pivot is parented to the camera, so it tracks the view; the scene must hold
  // the camera for it to render (createScene adds it).
  const handPivot = new THREE.Group();
  handPivot.name = 'handPivot';
  handPivot.position.set(0.32, -0.34, -0.6);
  const hand = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.42, 0.12),
    new THREE.MeshLambertMaterial({ color: HAND_COLOR }),
  );
  hand.position.set(0, -0.21, 0);
  handPivot.add(hand);
  camera.add(handPivot);
  scene.add(camera);
  let swingStart = -Infinity;

  function renderView({ pose, aim }: { pose: { x: number; y: number; z: number; yaw: number; pitch: number }; aim: VoxelHit | null }): void {
    camera.position.set(pose.x, pose.y, pose.z);
    const look = lookDirection({ yaw: pose.yaw, pitch: pose.pitch });
    lookTarget.set(camera.position.x + look.x, camera.position.y + look.y, camera.position.z + look.z);
    camera.lookAt(lookTarget);
    handPivot.rotation.x = HAND_REST_ROTATION_X + swingPose({ tSinceStart: performance.now() - swingStart, durationMs: SWING_DURATION_MS, peakRad: SWING_PEAK_RAD });
    if (!aim) { highlight.visible = false; return; }
    highlight.visible = true;
    highlight.position.set(aim.hit[0] + 0.5, aim.hit[1] + 0.5, aim.hit[2] + 0.5);
  }

  function swing(now = performance.now()): void {
    swingStart = now;
  }

  function present(): void {
    renderer.render(scene, camera);
  }

  return { renderView, swing, present };
}
