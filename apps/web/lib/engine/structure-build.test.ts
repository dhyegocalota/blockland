import { describe, expect, it } from 'vitest';
import { SIZE_X } from './constants';
import {
  STRUCTURE_FORWARD, STRUCTURE_MARGIN, structureReach, structureTarget,
} from './structure-build';

describe('structureReach', () => {
  it('gives the ball the widest remesh', () => {
    expect(structureReach('ball')).toBe(9);
  });

  it('gives cola a medium remesh', () => {
    expect(structureReach('cola')).toBe(6);
  });

  it('uses the default for the rest', () => {
    expect(structureReach('trophy')).toBe(4);
    expect(structureReach('steve')).toBe(4);
  });
});

describe('structureTarget', () => {
  it('centres on the aim hit when present', () => {
    const target = structureTarget({ aim: { x: 100, z: 200 }, playerX: 0, playerZ: 0, yaw: 0 });
    expect(target).toEqual({ cx: 100, cz: 200 });
  });

  it('builds a fixed distance ahead when aiming at the sky', () => {
    const target = structureTarget({ aim: null, playerX: 100, playerZ: 100, yaw: 0 });
    expect(target.cz).toBe(100 + STRUCTURE_FORWARD);
    expect(target.cx).toBe(100);
  });

  it('clamps the centre inside the build margin', () => {
    const target = structureTarget({ aim: { x: -50, z: SIZE_X + 50 }, playerX: 0, playerZ: 0, yaw: 0 });
    expect(target.cx).toBe(STRUCTURE_MARGIN);
    expect(target.cz).toBe(SIZE_X - STRUCTURE_MARGIN);
  });
});
