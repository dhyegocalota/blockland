// Single-player creature lifecycle + the player's damage handling, dependency-inverted onto the shared
// GameRuntime. Owns spawn/populate/update/hit/defeat for the local (offline) creatures, the scoring,
// poofs and respawn scheduling. The AI is pure (stepCreatureDirection, stepCreaturePosition,
// creatureBitesPlayer, knockbackVector, sphere-cast, creature-spawn); the three.js body lives in
// rendering/creature-view.ts and is reached only through runtime.buildCreatureBody / syncCreatureMesh /
// knockbackCreatureMesh / disposeCreatureMesh, so this module never touches three.js.
import { Vec3 } from '../vec3';
import { t } from '../../i18n';
import { debug } from '../../log';
import {
  EYE_HEIGHT, HURT_COOLDOWN, MAX_HEARTS, REACH, RESPAWN_DELAY_MS, SIZE_X, SIZE_Z,
} from '../constants';
import { CREATURE_DEFS, stepCreatureDirection } from './creatures';
import { sphereCastClosest } from '../sphere-cast';
import { STARTING_ROSTER, spawnPosition } from './creature-spawn';
import { bobOffset, creatureBitesPlayer, FLASH_TIME, knockbackVector, stepCreaturePosition } from './creature-combat';
import { offlineKillFeed } from './feed-events';
import { canCollectHeart, heartDropExpired } from '../heart-drop';
import type { Creature, GameRuntime } from '../runtime';

export function createCreatureSimulation(runtime: GameRuntime): void {
  const { camera } = runtime;
  let nextHeartDropId = 1;

  runtime.spawnCreature = function spawnCreature(typeKey: string): void {
    const def = CREATURE_DEFS[typeKey];
    if (!def) throw new Error(`unknown creature ${typeKey}`);
    const { x, z } = spawnPosition({ sizeX: SIZE_X, sizeZ: SIZE_Z, random: Math.random });
    const y = runtime.groundHeight(x, z) + def.size[1] / 2;
    const { mesh, body } = runtime.buildCreatureBody(def, x, y, z);
    runtime.creatures.push({
      typeKey, def, pos: new Vec3(x, y, z), mesh, body,
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
      const toPlayerX = player.pos.x - cr.pos.x;
      const toPlayerZ = player.pos.z - cr.pos.z;
      const dist = Math.hypot(toPlayerX, toPlayerZ);
      const isMonster = cr.def.kind === 'monster';
      const hostile = isMonster && !runtime.state.peaceful;

      const motion = stepCreatureDirection({
        toPlayerX, toPlayerZ, dist, isMonster, peaceful: runtime.state.peaceful,
        dir: cr.dir, timer: cr.timer, random: Math.random,
      });
      cr.dir = motion.dir; cr.timer = motion.timer;

      const stepped = stepCreaturePosition({
        x: cr.pos.x, z: cr.pos.z, dir: cr.dir, speed: cr.def.speed, dt, sizeX: SIZE_X, sizeZ: SIZE_Z,
      });
      const y = runtime.groundHeight(stepped.x, stepped.z) + cr.def.size[1] / 2 + bobOffset(cr.bob);
      cr.pos.set(stepped.x, y, stepped.z);
      runtime.syncCreatureMesh(cr, { x: stepped.x, y, z: stepped.z, rotationY: cr.dir, flashing: cr.flash > 0 });

      const verticalGap = Math.abs(player.pos.y - EYE_HEIGHT - cr.pos.y);
      if (hostile && player.hurtCooldown === 0 && creatureBitesPlayer({ horizontalDistance: dist, verticalGap })) runtime.hurtPlayer();
    }
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
    const dir = runtime.cameraForward();
    const targets = runtime.creatures.map((cr) => ({ x: cr.pos.x, y: cr.pos.y, z: cr.pos.z, radius: Math.max(...cr.def.size) * 0.7 }));
    const pick = sphereCastClosest({ origin: camera.position, dir, targets, maxDist: REACH });
    return pick ? { creature: runtime.creatures[pick.index], t: pick.t } : null;
  };

  runtime.hitCreature = function hitCreature(cr: Creature): void {
    const { player } = runtime.state;
    cr.hp -= 1;
    cr.flash = FLASH_TIME;
    runtime.blip(cr.def.kind === 'monster' ? 300 : 880, 0.08);
    const knock = knockbackVector({ creatureX: cr.pos.x, creatureZ: cr.pos.z, playerX: player.pos.x, playerZ: player.pos.z });
    runtime.knockbackCreatureMesh(cr, knock);
    debug('engine', 'hit creature', { kind: cr.typeKey, hp: cr.hp, x: Math.round(cr.pos.x), z: Math.round(cr.pos.z) });
    if (cr.hp > 0) return;
    runtime.defeatCreature(cr);
  };

  runtime.defeatCreature = function defeatCreature(cr: Creature): void {
    const { player } = runtime.state;
    const bridge = runtime.bridge;
    if (bridge) bridge.hud.onEvent(offlineKillFeed({ name: bridge.resolveName(), creatureName: t(cr.def.nameKey) }));
    runtime.spawnPoof(cr.pos, cr.def.color);
    const dropId = nextHeartDropId++;
    const dropPos = cr.pos.clone();
    runtime.heartDrops.push({ id: dropId, pos: dropPos, spawnedAt: performance.now() });
    runtime.heartDropRuntime.spawn({ id: dropId, x: dropPos.x, y: dropPos.y, z: dropPos.z });
    player.stars += cr.def.reward;
    player.bag += 1;
    runtime.toast(t('toast.reward', { emoji: cr.def.emoji, reward: cr.def.reward }));
    runtime.blip(660, 0.12); setTimeout(() => runtime.blip(990, 0.12), 90);
    runtime.updateStats();
    runtime.disposeCreatureMesh(cr);
    runtime.creatures.splice(runtime.creatures.indexOf(cr), 1);
    setTimeout(() => { if (!runtime.state.disposed) runtime.spawnCreature(cr.typeKey); }, RESPAWN_DELAY_MS);
  };

  runtime.updateHeartDrops = function updateHeartDrops(now: number): void {
    runtime.heartDropRuntime.update(now / 1000);
    const { player } = runtime.state;
    const playerPos = new Vec3(player.pos.x, player.pos.y - EYE_HEIGHT, player.pos.z);
    for (let i = runtime.heartDrops.length - 1; i >= 0; i--) {
      const drop = runtime.heartDrops[i];
      if (canCollectHeart({ drop, playerPos, hearts: player.hearts })) {
        player.hearts += 1;
        runtime.heartDrops.splice(i, 1);
        runtime.heartDropRuntime.remove(drop.id);
        runtime.blip(990, 0.1);
        runtime.updateStats();
        debug('engine', 'heart collected', { id: drop.id, hearts: player.hearts });
        continue;
      }
      if (!heartDropExpired({ drop, now })) continue;
      runtime.heartDrops.splice(i, 1);
      runtime.heartDropRuntime.remove(drop.id);
    }
  };
}
