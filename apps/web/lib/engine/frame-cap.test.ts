import { describe, expect, it } from 'vitest';
import { FRAME_MS, MAX_DT, nextFrame, smoothFps } from './frame-cap';

describe('nextFrame', () => {
  it('skips a frame inside the cap without advancing', () => {
    const timing = nextFrame({ now: 1000 + FRAME_MS / 2, last: 1000 });
    expect(timing.skip).toBe(true);
    expect(timing.last).toBe(1000);
    expect(timing.dt).toBe(0);
  });

  it('runs and carries the leftover when the cap is met', () => {
    const now = 1000 + FRAME_MS + 3;
    const timing = nextFrame({ now, last: 1000 });
    expect(timing.skip).toBe(false);
    expect(timing.last).toBe(now - ((now - 1000) % FRAME_MS));
    expect(timing.dt).toBeCloseTo((FRAME_MS + 3) / 1000);
  });

  it('clamps dt after a long stall', () => {
    const timing = nextFrame({ now: 5000, last: 0 });
    expect(timing.dt).toBe(MAX_DT);
  });
});

describe('smoothFps', () => {
  it('blends toward the instantaneous fps', () => {
    expect(smoothFps({ fps: 60, dt: 1 / 60 })).toBeCloseTo(60);
  });

  it('keeps the previous fps when dt is zero', () => {
    expect(smoothFps({ fps: 42, dt: 0 })).toBe(42);
  });
});
