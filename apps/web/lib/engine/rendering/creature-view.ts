// The three.js body of a creature and the player's screen damage cue, dependency-inverted onto the
// shared GameRuntime. This is the ONLY place the local creatures touch three.js: the offline
// simulation (offline/creature-simulation.ts) builds, moves, knocks back and disposes a creature's
// mesh exclusively through these runtime methods, so its AI stays pure. Exercised by e2e.
import * as THREE from 'three';
import {
  DAMAGE_BLIP_DURATION, DAMAGE_BLIP_FREQ, HURT_FLASH_MS,
} from '../constants';
import { makeFaceMaterial } from './materials';
import { Vec3 } from '../vec3';
import type { CreatureDef } from '../offline/creatures';
import type { GfxCreatureBody, GfxGroup } from './gfx';
import type { Creature, GameRuntime } from '../runtime';

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

  runtime.buildCreatureBody = function buildCreatureBody(def: CreatureDef, x: number, y: number, z: number): {
    mesh: GfxGroup;
    body: GfxCreatureBody;
  } {
    const body = new THREE.Mesh(new THREE.BoxGeometry(...def.size), makeFaceMaterial(def.color));
    const mesh = new THREE.Group();
    mesh.add(body);
    mesh.position.set(x, y, z);
    runtime.creatureGroup.add(mesh);
    return { mesh, body };
  };

  runtime.syncCreatureMesh = function syncCreatureMesh(cr: Creature, transform: {
    x: number; y: number; z: number; rotationY: number; flashing: boolean;
  }): void {
    cr.mesh.position.x = transform.x;
    cr.mesh.position.z = transform.z;
    cr.mesh.position.y = transform.y;
    cr.mesh.rotation.y = transform.rotationY;
    cr.body.material.emissive = new THREE.Color(transform.flashing ? '#ff0000' : '#000000');
  };

  runtime.knockbackCreatureMesh = function knockbackCreatureMesh(cr: Creature, delta: { x: number; z: number }): void {
    cr.pos.x += delta.x;
    cr.pos.z += delta.z;
    cr.mesh.position.x = cr.pos.x;
    cr.mesh.position.z = cr.pos.z;
  };

  runtime.disposeCreatureMesh = function disposeCreatureMesh(cr: Creature): void {
    runtime.creatureGroup.remove(cr.mesh);
    cr.body.geometry.dispose();
  };

  // The point-of-view damage cue: a red wash over the screen, the hearts shake, and a thud. Driven by
  // taking damage — locally offline, and by the server's Hurt message in co-op.
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
