// Stamping a chosen magic structure, dependency-inverted onto the shared GameRuntime: aim a longer
// reach, resolve the target cell, then stamp the structure's cells (skipping any that would trap a
// player) and remesh. The target math (structureTarget) and the per-kind cell layout (structureDef)
// are pure + unit-tested; this is the glue that drives them against the live world + coop.
import { t } from '../i18n';
import { debug } from '../log';
import { STRUCTURE_REACH_DIST } from './constants';
import { type StructureKind, structureDef } from './structures';
import { structureTarget } from './structure-build';
import type { EditCell } from '../protocol';
import type { GameRuntime } from './runtime';

export function createStructurePlacement(runtime: GameRuntime): void {
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
