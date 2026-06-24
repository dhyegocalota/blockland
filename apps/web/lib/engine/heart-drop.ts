// A dropped heart's gentle bob, used by the renderer (heart-drop-runtime) so the floating-heart pickup
// animates identically. The pickup/heal RULE is server-authoritative (Rust game-core) — the client renders.
import { Vec3 } from './vec3';
import { HEART_BOB_HEIGHT, HEART_BOB_SPEED } from './constants';

export interface HeartDrop {
  id: number;
  pos: Vec3;
  spawnedAt: number;
}

// How high a drop hovers above its base position at time `t` (seconds), bobbing gently up and down.
export function heartBobOffset(t: number): number {
  return HEART_BOB_HEIGHT * Math.sin(t * HEART_BOB_SPEED);
}
