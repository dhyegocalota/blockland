// Player world actions, dependency-inverted onto the shared GameRuntime: the crosshair voxel raycast,
// the primary tap target choice (player/creature/block), block break + place, the magic-structure
// stamp, the welcome monument, the world reset, and the scoreboard helpers. Pure pieces it leans on
// (chooseCoopTarget/chooseLocalTarget, place-eligibility, structureTarget, the DDA raycast, scoreboard)
// are already unit-tested; this is the glue that drives them against the live world + coop.
import * as THREE from 'three';
import { t } from '../i18n';
import { debug } from '../log';
import {
  AIR, EYE_HEIGHT, FACE_ID, PLAYER_HEIGHT, PLAYER_RADIUS, REACH, SIZE_X, SIZE_Z,
} from './constants';
import { blockById } from './blocks';
import { heightAt } from './worldgen';
import { type VoxelHit, raycastVoxel as ddaRaycast } from './raycast';
import { cellOverlapsActor } from './actors';
import { type StructureKind, structureDef } from './structures';
import { structureTarget } from './structure-build';
import { bestScore, heartsLabel, persistedRecord } from './scoreboard';
import { canPlaceSelected as canPlaceOffline, shouldSpendBlock } from './place-eligibility';
import { chooseCoopTarget, chooseLocalTarget } from './attack-target';
import { DIG_BLIP_DURATION, DIG_BLIP_FREQ, MAX_HEARTS, STRUCTURE_REACH_DIST } from './engine-config';
import type { EditCell } from '../protocol';
import type { GameRuntime } from './runtime';

export function createActions(runtime: GameRuntime): void {
  const { camera } = runtime;

  runtime.buildWelcomeMonument = function buildWelcomeMonument() {
    const cx = SIZE_X >> 1, cz = SIZE_Z >> 1;
    const top = heightAt(cx, cz);
    runtime.setVoxel(cx, top + 1, cz, FACE_ID);
    runtime.setVoxel(cx, top + 2, cz, FACE_ID);
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) runtime.setVoxel(cx + dx, top + 1, cz + dz, 8);
  };

  // The admin wiped the world: rebuild it in place (like a fresh boot) and respawn, so every player
  // resets without being kicked back to the lobby. The server's reset already cleared its own world
  // and creatures; the local creatures (single-player) and poofs are cleared to match.
  runtime.resetLocalWorld = function resetLocalWorld(): void {
    const { player } = runtime.state;
    runtime.chime();
    runtime.world.reset();
    runtime.buildWelcomeMonument();
    runtime.updateChunks(true);
    runtime.processMeshQueue(runtime.isTouch ? 24 : 60);
    runtime.poofRuntime.clear();
    player.pos.copy(runtime.spawnPoint());
    player.vel.set(0, 0, 0);
    runtime.savePos();
  };

  // ---------- Scoreboard ----------
  runtime.storedBest = function storedBest(): number {
    const stored = localStorage.getItem(runtime.bestKey);
    return stored ? Number(stored) : 0;
  };

  runtime.recordServerScore = function recordServerScore(score: number): void {
    localStorage.setItem(runtime.bestKey, String(persistedRecord({ serverScore: score, stored: runtime.storedBest() })));
  };

  runtime.updateStats = function updateStats(): void {
    const { player } = runtime.state;
    runtime.el('hearts').textContent = heartsLabel({ hearts: player.hearts, maxHearts: MAX_HEARTS });
    runtime.el('stars').textContent = `⭐ ${player.stars}`;
    runtime.el('bag').textContent = `🎒 ${player.bag}`;
    runtime.el('record').textContent = `🏆 ${bestScore({ stars: player.stars, stored: runtime.storedBest() })}`;
  };

  // ---------- Voxel raycast (DDA) ----------
  runtime.raycastVoxel = function raycastVoxel(maxDist = REACH): VoxelHit | null {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    return ddaRaycast({ world: runtime.world, origin: camera.position, dir, maxDist });
  };

  // ---------- Build / break ----------
  runtime.primaryAction = function primaryAction(): void {
    const block = runtime.raycastVoxel();
    const blockDistance = block ? new THREE.Vector3(block.hit[0] + 0.5, block.hit[1] + 0.5, block.hit[2] + 0.5).distanceTo(camera.position) : Infinity;
    if (runtime.coop) {
      const playerHit = runtime.raycastRemotePlayer();
      const serverHit = runtime.raycastServerCreature();
      const target = chooseCoopTarget({
        playerT: playerHit ? playerHit.t : null, creatureT: serverHit ? serverHit.t : null,
        blockDistance, hasBlock: !!block,
      });
      if (target === 'player' && playerHit) { runtime.attackRemotePlayer(playerHit.player); return; }
      if (target === 'creature' && serverHit) { runtime.hitServerCreature(serverHit.creature); return; }
      if (target === 'block' && block) runtime.breakBlock(block);
      return;
    }
    const creatureHit = runtime.raycastCreature();
    const target = chooseLocalTarget({ creatureT: creatureHit ? creatureHit.t : null, blockDistance, hasBlock: !!block });
    if (target === 'creature' && creatureHit) { runtime.hitCreature(creatureHit.creature); return; }
    if (target === 'block' && block) runtime.breakBlock(block);
  };

  runtime.breakBlock = function breakBlock(r: VoxelHit): void {
    const { player } = runtime.state;
    // Same hit feedback a creature attack gives: a poof at the struck cell on every tap, tinted the
    // block's own colour (dirt puffs brown, stone grey...), so digging reads as a hit too.
    const struck = blockById(runtime.getVoxel(r.hit[0], r.hit[1], r.hit[2]));
    if (struck) runtime.spawnPoof(new THREE.Vector3(r.hit[0] + 0.5, r.hit[1] + 0.5, r.hit[2] + 0.5), struck.color);
    // Co-op: the server counts the taps and decides the break (authoritative dig). We just send the tap
    // and chip — the block is removed + collected when the server's break edit comes back to us.
    if (runtime.coop) {
      runtime.coop.sendDig(r.hit[0], r.hit[1], r.hit[2]);
      runtime.blip(DIG_BLIP_FREQ, DIG_BLIP_DURATION);
      return;
    }
    const removed = runtime.getVoxel(r.hit[0], r.hit[1], r.hit[2]);
    runtime.setVoxel(r.hit[0], r.hit[1], r.hit[2], AIR);
    runtime.remeshRegion(r.hit[0] - 1, r.hit[0] + 1, r.hit[2] - 1, r.hit[2] + 1);
    player.bag += 1;
    // Co-op banks the block server-side (it credits the broken block and pushes the new counts back);
    // offline the local inventory is authoritative, so bank + repaint here.
    if (!runtime.coop) { runtime.inventory.bank(removed); runtime.updateHotbarCounts(); }
    runtime.updateStats();
    runtime.blip(220, 0.08);
    debug('engine', 'break block', { x: r.hit[0], y: r.hit[1], z: r.hit[2], id: removed });
  };

  runtime.placeBlock = function placeBlock(): void {
    const { state } = runtime;
    const r = runtime.raycastVoxel();
    if (!r) return;
    const [px, py, pz] = r.place;
    if (!runtime.inBounds(px, py, pz) || runtime.getVoxel(px, py, pz) !== AIR) return;
    if (runtime.overlapsPlayer(px, py, pz)) return;
    if (!runtime.canPlaceSelected()) { runtime.toast(t('toast.out_of_blocks')); runtime.blip(160, 0.1); return; }
    // Co-op spends the block server-side (it decrements and pushes the new counts back); offline the
    // local inventory is authoritative, so spend + repaint here.
    if (!runtime.coop && shouldSpendBlock({ infiniteResources: state.infiniteResources })) { runtime.inventory.spend(state.selected); runtime.updateHotbarCounts(); }
    runtime.setVoxel(px, py, pz, state.selected);
    runtime.remeshRegion(px - 1, px + 1, pz - 1, pz + 1);
    runtime.sendCoopEdit('place', px, py, pz, state.selected);
    runtime.blip(state.selected === FACE_ID ? 720 : 520, 0.08);
    debug('engine', 'place block', { x: px, y: py, z: pz, id: state.selected });
  };

  // Whether the selected block can be placed: co-op reads the server-authoritative inventory + infinite
  // flag; offline reads the local BlockInventory + the local infinite toggle.
  runtime.canPlaceSelected = function canPlaceSelected(): boolean {
    const { coop, state } = runtime;
    if (coop) return coop.infinite || coop.inventoryCount(state.selected) > 0;
    return canPlaceOffline({ infiniteResources: state.infiniteResources, count: runtime.inventory.count(state.selected) });
  };

  // True if the cell would land on the local player or any remote player (no building on people).
  runtime.overlapsPlayer = function overlapsPlayer(x: number, y: number, z: number): boolean {
    const p = runtime.state.player.pos;
    const overlaps = (feetX: number, feetY: number, feetZ: number): boolean =>
      cellOverlapsActor({ x, y, z, feetX, feetY, feetZ, radius: PLAYER_RADIUS, height: PLAYER_HEIGHT });
    if (overlaps(p.x, p.y - EYE_HEIGHT, p.z)) return true;
    if (!runtime.coop) return false;
    return runtime.coop.getColliders().some((a) => overlaps(a.x, a.y, a.z));
  };

  // ---------- Magic structures ----------
  runtime.buildStructure = function buildStructure(kind: StructureKind): void {
    const { player } = runtime.state;
    if (runtime.blockedStructures.has(kind)) { runtime.toast(t('build.blocked')); return; }
    const aim = runtime.raycastVoxel(STRUCTURE_REACH_DIST);
    const { cx, cz } = structureTarget({
      aim: aim ? { x: aim.hit[0], z: aim.hit[2] } : null,
      playerX: player.pos.x, playerZ: player.pos.z, yaw: player.yaw,
    });
    const gy = runtime.groundHeight(cx, cz);
    const def = structureDef(kind);
    const cells: EditCell[] = [];
    // Skip any cell that would land on a player so a structure can never trap someone.
    const collect = (x: number, y: number, z: number, id: number): void => {
      if (runtime.overlapsPlayer(x, y, z)) return;
      runtime.setVoxel(x, y, z, id);
      cells.push({ x, y, z, id });
    };
    def.stamp({ set: collect, cx, gy, cz });
    runtime.remeshRegion(cx - def.reach, cx + def.reach, cz - def.reach, cz + def.reach);
    runtime.coop?.sendEditBatch(cells);
    runtime.toast(t(def.builtToastKey));
    runtime.blip(680, 0.12); setTimeout(() => runtime.blip(1020, 0.14), 110);
    debug('engine', 'structure built', { kind, x: cx, y: gy, z: cz });
  };
}
