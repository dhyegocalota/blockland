// Creature lifecycle + the player's damage cues, dependency-inverted onto the shared GameRuntime.
// Owns spawn/populate/update/hit/defeat for the local (single-player) creatures, the poof particle
// glue, and the co-op request raycasts (server creatures + pvp players). Pure pieces it leans on
// (stepCreatureDirection, stepCreaturePosition, creatureBitesPlayer, knockbackVector, sphereCastClosest,
// creature-spawn) are already unit-tested; this is the three.js/DOM glue around them, exercised by e2e.
import * as THREE from 'three';
import { t } from '../../i18n';
import { debug } from '../../log';
import {
  DAMAGE_BLIP_DURATION, DAMAGE_BLIP_FREQ, EYE_HEIGHT, HURT_COOLDOWN, HURT_FLASH_MS, MAX_HEARTS,
  REACH, RESPAWN_DELAY_MS, SIZE_X, SIZE_Z,
} from '../constants';
import { CREATURE_DEFS, stepCreatureDirection } from '../creatures';
import { creatureDefFor } from '../creature-snapshot';
import { sphereCastClosest } from '../sphere-cast';
import { STARTING_ROSTER, spawnPosition } from '../creature-spawn';
import { bobOffset, creatureBitesPlayer, FLASH_TIME, knockbackVector, stepCreaturePosition } from '../creature-combat';
import { makeFaceMaterial } from './materials';
import type { CoopCreature, CoopPlayer } from '../../coop';
import type { Creature, GameRuntime } from '../runtime';

export function createCreatureRuntime(runtime: GameRuntime): void {
  const { camera } = runtime;

  runtime.spawnPoof = (pos: THREE.Vector3, color: string): void => runtime.poofRuntime.spawn(pos, color);
  runtime.updatePoofs = (dt: number): void => runtime.poofRuntime.update(dt);

  runtime.spawnCreature = function spawnCreature(typeKey: string): void {
    const def = CREATURE_DEFS[typeKey];
    if (!def) throw new Error(`unknown creature ${typeKey}`);
    const { x, z } = spawnPosition({ sizeX: SIZE_X, sizeZ: SIZE_Z, random: Math.random });
    const body = new THREE.Mesh(new THREE.BoxGeometry(...def.size), makeFaceMaterial(def.color));
    const mesh = new THREE.Group();
    mesh.add(body);
    mesh.position.set(x, runtime.groundHeight(x, z) + def.size[1] / 2, z);
    runtime.creatureGroup.add(mesh);
    runtime.creatures.push({
      typeKey, def, mesh, body,
      hp: def.hp,
      dir: Math.random() * Math.PI * 2,
      timer: 0, bob: Math.random() * Math.PI * 2, flash: 0,
    });
  };

  runtime.populateCreatures = function populateCreatures(): void {
    for (const kind of STARTING_ROSTER) runtime.spawnCreature(kind);
  };

  runtime.updateCreatures = function updateCreatures(dt: number): void {
    const { player } = runtime.state;
    player.hurtCooldown = Math.max(0, player.hurtCooldown - dt);
    for (const cr of runtime.creatures) {
      cr.timer -= dt;
      cr.bob += dt * 6;
      cr.flash = Math.max(0, cr.flash - dt);
      const toPlayer = new THREE.Vector3().subVectors(player.pos, cr.mesh.position);
      toPlayer.y = 0;
      const dist = toPlayer.length();
      const isMonster = cr.def.kind === 'monster';
      const hostile = isMonster && !runtime.state.peaceful;

      const motion = stepCreatureDirection({
        toPlayerX: toPlayer.x, toPlayerZ: toPlayer.z, dist, isMonster, peaceful: runtime.state.peaceful,
        dir: cr.dir, timer: cr.timer, random: Math.random,
      });
      cr.dir = motion.dir; cr.timer = motion.timer;

      const stepped = stepCreaturePosition({
        x: cr.mesh.position.x, z: cr.mesh.position.z, dir: cr.dir, speed: cr.def.speed, dt, sizeX: SIZE_X, sizeZ: SIZE_Z,
      });
      cr.mesh.position.x = stepped.x;
      cr.mesh.position.z = stepped.z;
      cr.mesh.position.y = runtime.groundHeight(cr.mesh.position.x, cr.mesh.position.z) + cr.def.size[1] / 2 + bobOffset(cr.bob);
      cr.mesh.rotation.y = cr.dir;
      cr.body.material.emissive = new THREE.Color(cr.flash > 0 ? '#ff0000' : '#000000');

      const verticalGap = Math.abs(player.pos.y - EYE_HEIGHT - cr.mesh.position.y);
      if (hostile && player.hurtCooldown === 0 && creatureBitesPlayer({ horizontalDistance: dist, verticalGap })) runtime.hurtPlayer();
    }
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

  runtime.hurtPlayer = function hurtPlayer(): void {
    const { player } = runtime.state;
    player.hearts -= 1;
    player.hurtCooldown = HURT_COOLDOWN;
    runtime.flashDamage();
    runtime.updateStats();
    if (player.hearts <= 0) runtime.napAndRespawn();
  };

  runtime.napAndRespawn = function napAndRespawn(): void {
    const { player } = runtime.state;
    runtime.toast(t('toast.nap'));
    player.hearts = MAX_HEARTS;
    player.pos.copy(runtime.spawnPoint());
    player.vel.set(0, 0, 0);
    runtime.updateStats();
  };

  runtime.raycastCreature = function raycastCreature(): { creature: Creature; t: number } | null {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const targets = runtime.creatures.map((cr) => ({ x: cr.mesh.position.x, y: cr.mesh.position.y, z: cr.mesh.position.z, radius: Math.max(...cr.def.size) * 0.7 }));
    const pick = sphereCastClosest({ origin: camera.position, dir, targets, maxDist: REACH });
    return pick ? { creature: runtime.creatures[pick.index], t: pick.t } : null;
  };

  runtime.hitCreature = function hitCreature(cr: Creature): void {
    const { player } = runtime.state;
    cr.hp -= 1;
    cr.flash = FLASH_TIME;
    runtime.blip(cr.def.kind === 'monster' ? 300 : 880, 0.08);
    const knock = knockbackVector({ creatureX: cr.mesh.position.x, creatureZ: cr.mesh.position.z, playerX: player.pos.x, playerZ: player.pos.z });
    cr.mesh.position.x += knock.x;
    cr.mesh.position.z += knock.z;
    debug('engine', 'hit creature', { kind: cr.typeKey, hp: cr.hp, x: Math.round(cr.mesh.position.x), z: Math.round(cr.mesh.position.z) });
    if (cr.hp > 0) return;
    runtime.defeatCreature(cr);
  };

  runtime.defeatCreature = function defeatCreature(cr: Creature): void {
    const { player } = runtime.state;
    runtime.spawnPoof(cr.mesh.position, cr.def.color);
    player.stars += cr.def.reward;
    player.bag += 1;
    runtime.toast(t('toast.reward', { emoji: cr.def.emoji, reward: cr.def.reward }));
    runtime.blip(660, 0.12); setTimeout(() => runtime.blip(990, 0.12), 90);
    runtime.updateStats();
    runtime.creatureGroup.remove(cr.mesh);
    cr.body.geometry.dispose();
    runtime.creatures.splice(runtime.creatures.indexOf(cr), 1);
    setTimeout(() => { if (!runtime.state.disposed) runtime.spawnCreature(cr.typeKey); }, RESPAWN_DELAY_MS);
  };

  // Co-op: the server owns creatures, so an attack is a request. We aim the crosshair at a snapshot
  // creature (same sphere test as the local raycast) and ask the server to apply the hit; death,
  // reward and despawn all come back authoritatively in the next snapshot.
  runtime.raycastServerCreature = function raycastServerCreature(): { creature: CoopCreature; t: number } | null {
    if (!runtime.coop) return null;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const candidates = runtime.coop.getCreatures();
    const pick = sphereCastClosest({ origin: camera.position, dir, targets: candidates, maxDist: REACH });
    return pick ? { creature: candidates[pick.index], t: pick.t } : null;
  };

  runtime.hitServerCreature = function hitServerCreature(cr: CoopCreature): void {
    runtime.coop?.sendHit(cr.id);
    runtime.coop?.flashCreature(cr.id);
    runtime.spawnPoof(new THREE.Vector3(cr.x, cr.y, cr.z), creatureDefFor(cr.kind).color);
    const def = creatureDefFor(cr.kind);
    runtime.blip(def.kind === 'monster' ? 300 : 880, 0.08);
    debug('engine', 'hit request', { id: cr.id, kind: cr.kind });
  };

  // Co-op pvp: when the room has pvp on we aim the crosshair at a remote player (same sphere test as
  // creatures) and ask the server to apply the hit; the server validates pvp + range and replies with
  // Hurt to the target. Returns null when pvp is off so players never damage each other.
  runtime.raycastRemotePlayer = function raycastRemotePlayer(): { player: CoopPlayer; t: number } | null {
    if (!runtime.coop || !runtime.state.pvp) return null;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const candidates = runtime.coop.getPlayers();
    const pick = sphereCastClosest({ origin: camera.position, dir, targets: candidates, maxDist: REACH });
    return pick ? { player: candidates[pick.index], t: pick.t } : null;
  };

  runtime.attackRemotePlayer = function attackRemotePlayer(p: CoopPlayer): void {
    runtime.coop?.sendAttackPlayer(p.id);
    runtime.spawnPoof(new THREE.Vector3(p.x, p.y, p.z), '#ff5555');
    runtime.blip(300, 0.08);
    debug('engine', 'attack player', { id: p.id });
  };
}
