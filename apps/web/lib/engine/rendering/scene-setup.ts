// Three.js scene bootstrap: the renderer, camera, lights, sky (sun disc + clouds), the world group
// and the block highlight box. Pure construction — given the touch flag it returns the handles the
// engine wires together. No DOM beyond appending the canvas, no game state.
import * as THREE from 'three';
import { SIZE_X, SIZE_Z } from '../constants';

export interface SceneHandles {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  worldGroup: THREE.Group;
  highlight: THREE.LineSegments;
}

export function createScene({ isTouch }: { isTouch: boolean }): SceneHandles {
  const worldGroup = new THREE.Group();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fd8ff');
  scene.fog = new THREE.Fog('#bfeaff', isTouch ? 38 : 60, isTouch ? 108 : 150);
  scene.add(worldGroup);

  const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, isTouch ? 200 : 380);
  const renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: 'high-performance' });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(isTouch ? 1 : Math.min(devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);
  const canvas = renderer.domElement;

  scene.add(new THREE.HemisphereLight('#ffffff', '#88aa66', 0.95));
  const sun = new THREE.DirectionalLight('#fff4d6', 0.9);
  sun.position.set(60, 90, 30);
  scene.add(sun);

  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 16), new THREE.MeshBasicMaterial({ color: '#fff3b0' }));
  sunDisc.position.set(SIZE_X / 2 + 80, 110, SIZE_Z / 2 - 90);
  scene.add(sunDisc);
  for (let i = 0; i < 70; i++) {
    const cloud = new THREE.Mesh(
      new THREE.BoxGeometry(5 + Math.random() * 6, 2, 4 + Math.random() * 5),
      new THREE.MeshLambertMaterial({ color: '#ffffff' })
    );
    cloud.position.set(Math.random() * SIZE_X, 30 + Math.random() * 10, Math.random() * SIZE_Z);
    scene.add(cloud);
  }

  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.005, 1.005, 1.005)),
    new THREE.LineBasicMaterial({ color: '#ffffff' })
  );
  highlight.visible = false;
  scene.add(highlight);

  return { scene, camera, renderer, canvas, worldGroup, highlight };
}
