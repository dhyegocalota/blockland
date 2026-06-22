// The welcome monument stamped at the world centre on boot (and after a world reset): a two-cell-tall
// tenant face on a four-cell gold cross. The cell layout is pure so it can be unit-tested and, later,
// moved server-side; the three.js setVoxel writes stay in the glue (createWelcomeMonument).
import { FACE_ID, GOLD_ID, SIZE_X, SIZE_Z } from './constants';
import { heightAt } from './worldgen';
import type { EditCell } from '../protocol';
import type { GameRuntime } from './runtime';

// The monument cells in stamp order: the face column (bottom then top), then the gold cross around it.
export function welcomeMonumentCells({ cx, cz, top }: { cx: number; cz: number; top: number }): EditCell[] {
  const cells: EditCell[] = [
    { x: cx, y: top + 1, z: cz, id: FACE_ID },
    { x: cx, y: top + 2, z: cz, id: FACE_ID },
  ];
  for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) cells.push({ x: cx + dx, y: top + 1, z: cz + dz, id: GOLD_ID });
  return cells;
}

export function createWelcomeMonument(runtime: GameRuntime): void {
  runtime.buildWelcomeMonument = function buildWelcomeMonument() {
    const cx = SIZE_X >> 1, cz = SIZE_Z >> 1;
    const top = heightAt(cx, cz);
    for (const cell of welcomeMonumentCells({ cx, cz, top })) runtime.setVoxel(cell.x, cell.y, cell.z, cell.id);
  };
}
