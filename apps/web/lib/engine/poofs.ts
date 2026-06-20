// Poof particles: the little burst when a creature is defeated. The three.js mesh lives in the glue;
// the spawn velocity and the per-frame physics (gravity pull, shrink, fade-out) are pure numbers here
// so they stay unit-tested.

export const POOF_COUNT = 8;
export const POOF_LIFE = 0.7;
export const POOF_GRAVITY = 9;
export const POOF_SHRINK = 1.5;

export interface PoofVelocity {
  x: number;
  y: number;
  z: number;
}

// One particle's launch velocity: out sideways, up, with a short life.
export function spawnPoofVelocity(random: () => number): PoofVelocity {
  return {
    x: (random() - 0.5) * 4,
    y: random() * 4 + 1,
    z: (random() - 0.5) * 4,
  };
}

export interface PoofStep {
  life: number;
  velocityY: number;
  scaleFactor: number;
  dead: boolean;
}

// Advances one particle: gravity pulls it down, it shrinks, and it dies when its life runs out.
export function stepPoof({ life, velocityY, dt }: { life: number; velocityY: number; dt: number }): PoofStep {
  const nextLife = life - dt;
  return {
    life: nextLife,
    velocityY: velocityY - POOF_GRAVITY * dt,
    scaleFactor: 1 - dt * POOF_SHRINK,
    dead: nextLife <= 0,
  };
}
