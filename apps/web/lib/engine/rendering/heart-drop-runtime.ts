// Three.js glue for dropped hearts: a small red heart mesh per drop id, bobbing gently above its base
// position. The pickup rule + TTL are pure (see ../heart-drop.ts); this owns only the meshes, keyed by
// the drop id so both the offline simulation and the co-op snapshot reconciler spawn/move/remove the
// same way. The bob offset is pure (heartBobOffset) so the motion matches everywhere.
import * as THREE from 'three';
import { heartBobOffset } from '../heart-drop';

const HEART_COLOR = 0xff3355;
const HEART_SCALE = 0.16;

interface HeartMesh {
  group: THREE.Group;
  baseY: number;
  phase: number;
}

export interface HeartDropRuntime {
  spawn(args: { id: number; x: number; y: number; z: number }): void;
  move(args: { id: number; x: number; y: number; z: number }): void;
  update(elapsed: number): void;
  remove(id: number): void;
  clear(): void;
}

// A blocky little heart: two cubes side by side topped with a rotated cube, all red. Shared geometry +
// material across every drop (disposed once on clear), so spawning a heart is cheap.
function buildHeartGeometry(): THREE.BufferGeometry {
  const lobe = new THREE.BoxGeometry(1, 1, 1).translate(-0.45, 0.4, 0);
  const lobe2 = new THREE.BoxGeometry(1, 1, 1).translate(0.45, 0.4, 0);
  const bottom = new THREE.BoxGeometry(1, 1, 1).rotateZ(Math.PI / 4).scale(1.1, 1.1, 1).translate(0, -0.4, 0);
  return mergeBoxes([lobe, lobe2, bottom]);
}

function mergeBoxes(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const part of parts) {
    const indexed = part.toNonIndexed();
    positions.push(...Array.from(indexed.getAttribute('position').array));
    normals.push(...Array.from(indexed.getAttribute('normal').array));
    part.dispose();
    indexed.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return merged;
}

export function createHeartDropRuntime({ scene }: { scene: THREE.Scene }): HeartDropRuntime {
  const hearts = new Map<number, HeartMesh>();
  const geometry = buildHeartGeometry();
  const material = new THREE.MeshLambertMaterial({ color: HEART_COLOR, emissive: 0x3a0010 });

  function spawn({ id, x, y, z }: { id: number; x: number; y: number; z: number }): void {
    if (hearts.has(id)) return;
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.setScalar(HEART_SCALE);
    group.add(mesh);
    group.position.set(x, y, z);
    scene.add(group);
    hearts.set(id, { group, baseY: y, phase: id * 0.7 });
  }

  function move({ id, x, y, z }: { id: number; x: number; y: number; z: number }): void {
    const heart = hearts.get(id);
    if (!heart) return;
    heart.group.position.x = x;
    heart.group.position.z = z;
    heart.baseY = y;
  }

  function update(elapsed: number): void {
    for (const heart of hearts.values()) {
      heart.group.position.y = heart.baseY + heartBobOffset(elapsed + heart.phase);
      heart.group.rotation.y = elapsed + heart.phase;
    }
  }

  function remove(id: number): void {
    const heart = hearts.get(id);
    if (!heart) return;
    scene.remove(heart.group);
    hearts.delete(id);
  }

  function clear(): void {
    for (const heart of hearts.values()) scene.remove(heart.group);
    hearts.clear();
  }

  return { spawn, move, update, remove, clear };
}
