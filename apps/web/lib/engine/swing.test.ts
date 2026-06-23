import { describe, expect, it } from 'vitest';
import { swingPose } from './swing';

const durationMs = 220;
const peakRad = 0.8;
const pose = (tSinceStart: number): number => swingPose({ tSinceStart, durationMs, peakRad });

describe('swingPose', () => {
  it('rests before the swing starts', () => {
    expect(pose(-50)).toBe(0);
    expect(pose(0)).toBe(0);
  });

  it('returns to rest once the swing ends', () => {
    expect(pose(durationMs)).toBe(0);
    expect(pose(durationMs + 100)).toBe(0);
  });

  it('peaks at the halfway point', () => {
    expect(pose(durationMs / 2)).toBeCloseTo(peakRad, 5);
  });

  it('rises then settles', () => {
    const quarter = pose(durationMs / 4);
    const half = pose(durationMs / 2);
    const threeQuarter = pose((durationMs * 3) / 4);
    expect(quarter).toBeGreaterThan(0);
    expect(half).toBeGreaterThan(quarter);
    expect(threeQuarter).toBeLessThan(half);
    expect(threeQuarter).toBeGreaterThan(0);
  });

  it('stays bounded within [0, peak]', () => {
    for (let t = 0; t <= durationMs; t += 5) {
      const angle = pose(t);
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThanOrEqual(peakRad);
    }
  });
});
