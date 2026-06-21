// Pure aim trig: the world-space look direction from a yaw/pitch, and the yaw/pitch that point the
// player at a target cell (used by the look loop and the E2E test hook). No three.js — the engine
// copies these into camera/player vectors — so the math stays unit-tested.

export interface LookDirection {
  x: number;
  y: number;
  z: number;
}

export function lookDirection({ yaw, pitch }: { yaw: number; pitch: number }): LookDirection {
  return {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  };
}

export function aimYaw({
  targetX, targetZ, fromX, fromZ,
}: {
  targetX: number;
  targetZ: number;
  fromX: number;
  fromZ: number;
}): number {
  return Math.atan2(targetX - fromX, targetZ - fromZ);
}

export function aimPitch({
  targetX, targetY, targetZ, fromX, fromY, fromZ,
}: {
  targetX: number;
  targetY: number;
  targetZ: number;
  fromX: number;
  fromY: number;
  fromZ: number;
}): number {
  return Math.atan2(targetY - fromY, Math.hypot(targetX - fromX, targetZ - fromZ));
}
