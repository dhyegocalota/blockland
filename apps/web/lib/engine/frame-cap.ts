// Render-loop timing, pure: cap the update rate so 120Hz+ displays (and most phones) don't burn
// battery running at their native refresh, and smooth the measured fps. The requestAnimationFrame
// wiring stays in the glue; the cadence carry and dt clamp are numbers here, unit-tested.

export const FRAME_MS = 1000 / 60;
// Hard ceiling on a single step so a long stall (tab backgrounded) can't teleport the player.
export const MAX_DT = 0.05;
export const FPS_SMOOTHING = 0.1;

export interface FrameTiming {
  // True when this frame is within the cap and should be skipped (no carry advance).
  skip: boolean;
  // The new `last` timestamp, carrying the leftover so the cadence stays steady instead of drifting.
  last: number;
  dt: number;
}

export function nextFrame({ now, last }: { now: number; last: number }): FrameTiming {
  const elapsed = now - last;
  if (elapsed < FRAME_MS) return { skip: true, last, dt: 0 };
  return {
    skip: false,
    last: now - (elapsed % FRAME_MS),
    dt: Math.min(elapsed / 1000, MAX_DT),
  };
}

export function smoothFps({ fps, dt }: { fps: number; dt: number }): number {
  if (dt <= 0) return fps;
  return fps * (1 - FPS_SMOOTHING) + (1 / dt) * FPS_SMOOTHING;
}
