// Magic structures stamped voxel-by-voxel. Pure: caller supplies `set` and the origin.
import {
  BEDROCK_ID, BLACK_ID, BLUE_ID, CELESTE_ID, CYAN_ID, FACE_ID,
  GOLD_ID, GRASS_ID, HAIR_ID, RED_ID, SKIN_ID, WHITE_ID,
} from './constants';

export type SetVoxel = (x: number, y: number, z: number, id: number) => void;

interface Stamp {
  set: SetVoxel;
  cx: number;
  gy: number;
  cz: number;
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

export function stampCola({ set, cx, gy, cz }: Stamp): void {
  const R = 4, H = 17;
  for (let dy = 0; dy < H; dy++) {
    let id = RED_ID;
    if (dy === 0 || dy >= H - 2) id = 3;          // silvery top + bottom rim
    if (dy >= 7 && dy <= 9) id = WHITE_ID;          // white band
    const r = (dy === 0 || dy === H - 1) ? R - 1 : R;
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        if (dx * dx + dz * dz > r * r + 1) continue;
        set(cx + dx, gy + dy, cz + dz, id);
      }
  }
  set(cx, gy + H, cz, 3);                          // little pull-tab knob
}

export function stampSteve({ set, cx, gy, cz }: Stamp): void {
  const put = (dx: number, dy: number, dz: number, id: number): void => set(cx + dx, gy + dy, cz + dz, id);
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 3; dy++) { put(-1, dy, dz, BLUE_ID); put(1, dy, dz, BLUE_ID); } // jeans legs
    put(-1, 0, dz, BEDROCK_ID); put(1, 0, dz, BEDROCK_ID);                                   // shoes
    for (let dy = 4; dy <= 7; dy++) for (let dx = -1; dx <= 1; dx++) put(dx, dy, dz, CYAN_ID); // cyan shirt
    for (let dy = 4; dy <= 6; dy++) { put(-2, dy, dz, SKIN_ID); put(2, dy, dz, SKIN_ID); }   // bare arms
    for (let dy = 8; dy <= 9; dy++) for (let dx = -1; dx <= 1; dx++) put(dx, dy, dz, SKIN_ID); // head
  }
  for (let dx = -1; dx <= 1; dx++) for (let dz = 0; dz <= 1; dz++) put(dx, 10, dz, HAIR_ID);  // brown hair
  put(-1, 9, 1, HAIR_ID); put(1, 9, 1, HAIR_ID);                                              // hair back sides
}
