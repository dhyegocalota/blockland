// Block break / place / dig, dependency-inverted onto the shared GameRuntime: the crosshair voxel
// raycast, the primary tap target choice (player/creature/block), the break + place + the place
// eligibility and player-overlap guards. Pure pieces it leans on (chooseCoopTarget/chooseLocalTarget,
// place-eligibility, the DDA raycast, cellOverlapsActor) are already unit-tested; this is the glue that
// drives them against the live world + coop.
import * as THREE from 'three';
import { t } from '../i18n';
import { debug } from '../log';
import {
  AIR, DIG_BLIP_DURATION, DIG_BLIP_FREQ, EYE_HEIGHT, FACE_ID, PLAYER_HEIGHT, PLAYER_RADIUS, REACH,
} from './constants';
import { blockById } from './blocks';
import { type VoxelHit, raycastVoxel as ddaRaycast } from './raycast';
import { cellOverlapsActor } from './actors';
import { canPlaceSelected as canPlaceOffline, shouldSpendBlock } from './place-eligibility';
import { chooseCoopTarget, chooseLocalTarget } from './attack-target';
import type { GameRuntime } from './runtime';

export function createBlockActions(runtime: GameRuntime): void {
  const { camera } = runtime;

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
}
