// The magic structures, as one self-contained registry: each entry owns its i18n keys, build-menu
// emoji, remesh reach and the pure voxel stamp. Adding a structure = append one entry here (plus its
// `build.*`/`toast.built_*` strings in lib/i18n/catalog.ts for both locales). The kind id list,
// label/toast lookups, build-menu and admin toggles all derive from this — nothing is hand-maintained
// per structure elsewhere. Pure: a stamp receives `set` and the origin.
import {
  BEDROCK_ID, BLACK_ID, BLUE_ID, CELESTE_ID, FACE_ID,
  GOLD_ID, GRASS_ID, RED_ID, SKIN_ID, WHITE_ID,
} from './constants';

export type SetVoxel = (x: number, y: number, z: number, id: number) => void;

export interface Stamp {
  set: SetVoxel;
  cx: number;
  gy: number;
  cz: number;
}

export interface StructureDef {
  labelKey: string;
  builtToastKey: string;
  emoji: string;
  reach: number;
  stamp: (stamp: Stamp) => void;
}

function fillSquare(set: SetVoxel, cx: number, cz: number, y: number, half: number, id: number): void {
  for (let dx = -half; dx <= half; dx++)
    for (let dz = -half; dz <= half; dz++) set(cx + dx, y, cz + dz, id);
}

function stampSphere(set: SetVoxel, cx: number, cy: number, cz: number, radius: number, pick: (dx: number, dy: number, dz: number) => number): void {
  for (let dx = -radius; dx <= radius; dx++)
    for (let dy = -radius; dy <= radius; dy++)
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.hypot(dx, dy, dz) > radius + 0.3) continue;
        set(cx + dx, cy + dy, cz + dz, pick(dx, dy, dz));
      }
}

function ballPatchCenters(): number[][] {
  const centers = [[0, 1, 0], [0, -1, 0]];
  for (let k = 0; k < 5; k++) { const a = (k * 2 * Math.PI) / 5; centers.push([Math.cos(a) * 0.72, 0.5, Math.sin(a) * 0.72]); }
  for (let k = 0; k < 5; k++) { const a = ((k + 0.5) * 2 * Math.PI) / 5; centers.push([Math.cos(a) * 0.72, -0.5, Math.sin(a) * 0.72]); }
  return centers.map((c) => { const l = Math.hypot(...c); return [c[0] / l, c[1] / l, c[2] / l]; });
}

export function stampTrophy({ set, cx, gy, cz }: Stamp): void {
  fillSquare(set, cx, cz, gy, 2, GOLD_ID);
  fillSquare(set, cx, cz, gy + 1, 2, GRASS_ID);
  fillSquare(set, cx, cz, gy + 2, 1, GOLD_ID);
  for (let y = gy + 3; y <= gy + 6; y++) set(cx, y, cz, GOLD_ID);
  stampSphere(set, cx, gy + 9, cz, 3, () => GOLD_ID);
}

export function stampBall({ set, cx, gy, cz, radius }: Stamp & { radius: number }): void {
  const centers = ballPatchCenters();
  const cy = gy + radius;
  stampSphere(set, cx, cy, cz, radius, (dx, dy, dz) => {
    const len = Math.hypot(dx, dy, dz) || 1;
    const nx = dx / len, ny = dy / len, nz = dz / len;
    const black = centers.some((p) => nx * p[0] + ny * p[1] + nz * p[2] > 0.9);
    return black ? BLACK_ID : WHITE_ID;
  });
}

export function stampFigure({ set, cx, gy, cz }: Stamp): void {
  const put = (dx: number, dy: number, dz: number, id: number): void => set(cx + dx, gy + dy, cz + dz, id);
  for (let dy = 0; dy <= 2; dy++) { put(-1, dy, 0, WHITE_ID); put(1, dy, 0, WHITE_ID); } // legs/socks
  put(-1, 0, 0, BLACK_ID); put(1, 0, 0, BLACK_ID);                                       // boots
  for (let dy = 3; dy <= 6; dy++) {                                                        // Argentina striped jersey
    put(-1, dy, 0, CELESTE_ID); put(0, dy, 0, WHITE_ID); put(1, dy, 0, CELESTE_ID);
  }
  for (let dy = 3; dy <= 5; dy++) { put(-2, dy, 0, CELESTE_ID); put(2, dy, 0, CELESTE_ID); } // arms
  put(0, 7, 0, WHITE_ID);                                                                  // neck
  put(0, 8, 0, FACE_ID);                                                                     // the player face
}

export function stampBottle({ set, cx, gy, cz }: Stamp): void {
  const R = 4, H = 17;
  for (let dy = 0; dy < H; dy++) {
    let id = BLUE_ID;
    if (dy === 0 || dy >= H - 2) id = 3;          // silvery top + bottom rim
    const r = (dy === 0 || dy === H - 1) ? R - 1 : R;
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        if (dx * dx + dz * dz > r * r + 1) continue;
        set(cx + dx, gy + dy, cz + dz, id);
      }
  }
  set(cx, gy + H, cz, 3);                          // little cap knob
}

export function stampHero({ set, cx, gy, cz }: Stamp): void {
  const put = (dx: number, dy: number, dz: number, id: number): void => set(cx + dx, gy + dy, cz + dz, id);
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 3; dy++) { put(-1, dy, dz, GRASS_ID); put(1, dy, dz, GRASS_ID); } // green trousers
    put(-1, 0, dz, BEDROCK_ID); put(1, 0, dz, BEDROCK_ID);                                   // boots
    for (let dy = 4; dy <= 7; dy++) for (let dx = -1; dx <= 1; dx++) put(dx, dy, dz, RED_ID); // red shirt
    for (let dy = 4; dy <= 6; dy++) { put(-2, dy, dz, SKIN_ID); put(2, dy, dz, SKIN_ID); }   // bare arms
    for (let dy = 8; dy <= 9; dy++) for (let dx = -1; dx <= 1; dx++) put(dx, dy, dz, SKIN_ID); // head
  }
  for (let dx = -1; dx <= 1; dx++) for (let dz = 0; dz <= 1; dz++) put(dx, 10, dz, GOLD_ID);  // blond hair
  put(-1, 9, 1, GOLD_ID); put(1, 9, 1, GOLD_ID);                                              // hair back sides
}

const BALL_RADIUS = 8;
const BALL_REACH = 9;
const BOTTLE_REACH = 6;
const DEFAULT_REACH = 4;

export const STRUCTURE_DEFS = {
  trophy: { labelKey: 'build.trophy', builtToastKey: 'toast.built_trophy', emoji: '🏆', reach: DEFAULT_REACH, stamp: stampTrophy },
  ball: { labelKey: 'build.ball', builtToastKey: 'toast.built_ball', emoji: '⚽', reach: BALL_REACH, stamp: (s) => stampBall({ ...s, radius: BALL_RADIUS }) },
  figure: { labelKey: 'build.figure', builtToastKey: 'toast.built_figure', emoji: '🧑‍🦱', reach: DEFAULT_REACH, stamp: stampFigure },
  bottle: { labelKey: 'build.bottle', builtToastKey: 'toast.built_bottle', emoji: '🍾', reach: BOTTLE_REACH, stamp: stampBottle },
  hero: { labelKey: 'build.hero', builtToastKey: 'toast.built_hero', emoji: '🦸', reach: DEFAULT_REACH, stamp: stampHero },
} satisfies Record<string, StructureDef>;

export type StructureKind = keyof typeof STRUCTURE_DEFS;
export const STRUCTURE_KINDS = Object.keys(STRUCTURE_DEFS) as StructureKind[];

export function structureDef(kind: StructureKind): StructureDef {
  return STRUCTURE_DEFS[kind];
}
