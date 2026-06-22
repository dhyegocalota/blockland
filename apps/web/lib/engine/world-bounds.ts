// Keep a position inside the horizontal world and under the flight ceiling, matching the server's
// move validation so the client never sends an out-of-bounds position.
import { MAX_FLY_Y, SIZE_X, SIZE_Z } from './constants';

export function clampToWorld(position: { x: number; y: number; z: number }): void {
  position.x = Math.max(0, Math.min(SIZE_X, position.x));
  position.z = Math.max(0, Math.min(SIZE_Z, position.z));
  position.y = Math.min(MAX_FLY_Y, position.y);
}
