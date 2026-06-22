// Pure helpers for placing a magic structure: the target cell the structure centers on (where the
// player aims, or a fixed distance ahead when aiming at the sky), clamped to keep it off the world
// edge. The structure kinds and per-kind reach live in the registry (./structures); the stamping +
// three.js remesh stay in the glue.

import { SIZE_X, SIZE_Z } from './constants';

export const STRUCTURE_MARGIN = 12;
// How far ahead of the player a structure lands when they aim at the open sky.
export const STRUCTURE_FORWARD = 24;

export interface StructureTarget {
  cx: number;
  cz: number;
}

// Resolve the structure centre. With an aim hit we build there; otherwise we build a fixed distance
// in front of the player's facing. Either way it is clamped inside the build margin.
export function structureTarget({
  aim, playerX, playerZ, yaw,
}: {
  aim: { x: number; z: number } | null;
  playerX: number;
  playerZ: number;
  yaw: number;
}): StructureTarget {
  const targetX = aim ? aim.x : playerX + Math.sin(yaw) * STRUCTURE_FORWARD;
  const targetZ = aim ? aim.z : playerZ + Math.cos(yaw) * STRUCTURE_FORWARD;
  return {
    cx: clampMargin({ value: Math.round(targetX), max: SIZE_X }),
    cz: clampMargin({ value: Math.round(targetZ), max: SIZE_Z }),
  };
}

function clampMargin({ value, max }: { value: number; max: number }): number {
  return Math.max(STRUCTURE_MARGIN, Math.min(max - STRUCTURE_MARGIN, value));
}
