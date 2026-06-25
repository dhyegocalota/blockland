import { describe, expect, it } from 'vitest';
import { DEATH_FALL_MS, deathFall } from './death-fall';

describe('deathFall', () => {
  it('is flat (no fall) while alive', () => {
    expect(deathFall(null, 1000)).toEqual({ roll: 0, drop: 0 });
  });

  it('starts at no tilt the instant of death and grows toward the ground', () => {
    const start = deathFall(1000, 1000);
    expect(start.roll).toBe(0);
    expect(start.drop).toBe(0);
    const mid = deathFall(1000, 1000 + DEATH_FALL_MS / 2);
    expect(mid.roll).toBeGreaterThan(0);
    expect(mid.drop).toBeGreaterThan(0);
  });

  it('reaches its full roll + drop by the end of the fall and clamps after', () => {
    const end = deathFall(1000, 1000 + DEATH_FALL_MS);
    const past = deathFall(1000, 1000 + DEATH_FALL_MS * 5);
    expect(past).toEqual(end);
    expect(end.roll).toBeGreaterThan(1); // rolled well past upright, onto its side
    expect(end.drop).toBeGreaterThan(1); // eye sank toward the feet
  });
});
