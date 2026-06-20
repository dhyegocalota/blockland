import { describe, expect, it } from 'vitest';
import { type SphereTarget, sphereCastClosest } from './sphere-cast';

const origin = { x: 0, y: 0, z: 0 };
const forwardX = { x: 1, y: 0, z: 0 };

describe('sphereCastClosest', () => {
  it('returns null when there are no targets', () => {
    expect(sphereCastClosest({ origin, dir: forwardX, targets: [], maxDist: 10 })).toBeNull();
  });

  it('hits a target dead ahead and reports its forward distance', () => {
    const targets: SphereTarget[] = [{ x: 5, y: 0, z: 0, radius: 1 }];
    const pick = sphereCastClosest({ origin, dir: forwardX, targets, maxDist: 10 });
    expect(pick).toEqual({ index: 0, t: 5 });
  });

  it('ignores a target behind the origin', () => {
    const targets: SphereTarget[] = [{ x: -5, y: 0, z: 0, radius: 1 }];
    expect(sphereCastClosest({ origin, dir: forwardX, targets, maxDist: 10 })).toBeNull();
  });

  it('misses a target outside its bounding sphere', () => {
    const targets: SphereTarget[] = [{ x: 5, y: 2, z: 0, radius: 1 }];
    expect(sphereCastClosest({ origin, dir: forwardX, targets, maxDist: 10 })).toBeNull();
  });

  it('grazes a target whose sphere the ray clips', () => {
    const targets: SphereTarget[] = [{ x: 5, y: 0.9, z: 0, radius: 1 }];
    const pick = sphereCastClosest({ origin, dir: forwardX, targets, maxDist: 10 });
    expect(pick?.index).toBe(0);
    expect(pick?.t).toBe(5);
  });

  it('picks the nearest of several aligned targets', () => {
    const targets: SphereTarget[] = [
      { x: 8, y: 0, z: 0, radius: 1 },
      { x: 3, y: 0, z: 0, radius: 1 },
      { x: 6, y: 0, z: 0, radius: 1 },
    ];
    const pick = sphereCastClosest({ origin, dir: forwardX, targets, maxDist: 10 });
    expect(pick?.index).toBe(1);
    expect(pick?.t).toBe(3);
  });

  it('respects maxDist: a target just beyond range is not hit', () => {
    const targets: SphereTarget[] = [{ x: 5, y: 0, z: 0, radius: 0.5 }];
    expect(sphereCastClosest({ origin, dir: forwardX, targets, maxDist: 4 })).toBeNull();
  });

  it('respects maxDist: the same target within range is hit', () => {
    const targets: SphereTarget[] = [{ x: 5, y: 0, z: 0, radius: 0.5 }];
    expect(sphereCastClosest({ origin, dir: forwardX, targets, maxDist: 6 })?.index).toBe(0);
  });
});
