// Three.js glue for poof particles: spawns the little cubes into the scene and steps them each frame.
// The motion is pure (see poofs.ts); this owns the particle list and the THREE meshes. The factory
// returns spawn/update plus a clear() the world-reset uses to wipe particles in place.
import * as THREE from 'three';
import { POOF_COUNT, POOF_LIFE, spawnPoofVelocity, stepPoof } from './poofs';

interface Poof {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

export interface PoofRuntime {
  spawn(pos: THREE.Vector3, color: string): void;
  update(dt: number): void;
  clear(): void;
}

export function createPoofRuntime({ scene }: { scene: THREE.Scene }): PoofRuntime {
  const poofs: Poof[] = [];

  function spawn(pos: THREE.Vector3, color: string): void {
    for (let i = 0; i < POOF_COUNT; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial({ color }));
      m.position.copy(pos);
      scene.add(m);
      const v = spawnPoofVelocity(Math.random);
      poofs.push({ mesh: m, vel: new THREE.Vector3(v.x, v.y, v.z), life: POOF_LIFE });
    }
  }

  function update(dt: number): void {
    for (let i = poofs.length - 1; i >= 0; i--) {
      const p = poofs[i];
      const step = stepPoof({ life: p.life, velocityY: p.vel.y, dt });
      p.life = step.life;
      p.vel.y = step.velocityY;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.scale.multiplyScalar(step.scaleFactor);
      if (step.dead) { scene.remove(p.mesh); p.mesh.geometry.dispose(); poofs.splice(i, 1); }
    }
  }

  function clear(): void {
    for (const p of poofs) { scene.remove(p.mesh); p.mesh.geometry.dispose(); }
    poofs.length = 0;
  }

  return { spawn, update, clear };
}
