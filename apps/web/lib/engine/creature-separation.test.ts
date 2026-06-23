import { describe, expect, it } from 'vitest';
import { separateCreatures } from './creature-separation';
import { CREATURE_SEPARATION } from './constants';
import { Vec3 } from './vec3';

function horizontalGap(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

describe('separateCreatures', () => {
  it('splits two creatures spawned on the exact same spot', () => {
    const creatures = [
      { id: 1, pos: new Vec3(5, 10, 5) },
      { id: 2, pos: new Vec3(5, 10, 5) },
    ];
    separateCreatures(creatures);
    expect(horizontalGap(creatures[0].pos, creatures[1].pos)).toBeCloseTo(CREATURE_SEPARATION, 5);
  });

  it('pushes an overlapping pair to exactly the separation distance', () => {
    const creatures = [
      { id: 1, pos: new Vec3(0, 0, 0) },
      { id: 2, pos: new Vec3(0.3, 0, 0) },
    ];
    separateCreatures(creatures);
    expect(horizontalGap(creatures[0].pos, creatures[1].pos)).toBeCloseTo(CREATURE_SEPARATION, 5);
  });

  it('leaves creatures already far enough apart untouched', () => {
    const creatures = [
      { id: 1, pos: new Vec3(0, 0, 0) },
      { id: 2, pos: new Vec3(CREATURE_SEPARATION + 1, 0, 0) },
    ];
    separateCreatures(creatures);
    expect(creatures[0].pos).toEqual(new Vec3(0, 0, 0));
    expect(creatures[1].pos).toEqual(new Vec3(CREATURE_SEPARATION + 1, 0, 0));
  });

  it('keeps the vertical position owned by the ground clamp', () => {
    const creatures = [
      { id: 1, pos: new Vec3(0, 7, 0) },
      { id: 2, pos: new Vec3(0.2, 9, 0) },
    ];
    separateCreatures(creatures);
    expect(creatures[0].pos.y).toBe(7);
    expect(creatures[1].pos.y).toBe(9);
  });
});
