// The crosshair forward, the break poof, and the player's screen damage cue, dependency-inverted onto
// the shared GameRuntime. Thin three.js glue: reads the live camera, spawns poofs and runs the hurt
// flash. (Creatures are server-authoritative — the core owns them online and offline — and their meshes
// are built by coop-view, so this no longer builds creature bodies.)
import * as THREE from 'three';
import {
  DAMAGE_BLIP_DURATION, DAMAGE_BLIP_FREQ, HURT_FLASH_MS,
} from '../constants';
import { Vec3 } from '../vec3';
import type { GameRuntime } from '../runtime';

export function createCreatureView(runtime: GameRuntime): void {
  const { camera } = runtime;

  // The live camera's world forward, handed to the (pure) crosshair raycasts as a Vec3.
  runtime.cameraForward = (): Vec3 => {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    return new Vec3(dir.x, dir.y, dir.z);
  };
  runtime.spawnPoof = (pos: Vec3, color: string): void => runtime.poofRuntime.spawn(pos, color);
  runtime.updatePoofs = (dt: number): void => runtime.poofRuntime.update(dt);

  // The point-of-view damage cue: a red wash over the screen, the hearts shake, and a thud. Driven by
  // the server's Hurt message in co-op (online and offline-via-core both source it from the core).
  runtime.flashDamage = function flashDamage(): void {
    runtime.blip(DAMAGE_BLIP_FREQ, DAMAGE_BLIP_DURATION);
    const heartsEl = runtime.el('hearts');
    heartsEl.classList.add('hit');
    setTimeout(() => heartsEl.classList.remove('hit'), HURT_FLASH_MS);
    const flash = runtime.el('hurtFlash');
    flash.classList.remove('show');
    void flash.offsetWidth;
    flash.classList.add('show');
  };
}
