import { describe, expect, it } from 'vitest';
import { aimPitch, aimYaw, lookDirection } from './aim';

describe('lookDirection', () => {
  it('points down +z when looking straight ahead at yaw 0', () => {
    const dir = lookDirection({ yaw: 0, pitch: 0 });
    expect(dir.x).toBeCloseTo(0);
    expect(dir.y).toBeCloseTo(0);
    expect(dir.z).toBeCloseTo(1);
  });

  it('points down +x at a quarter-turn yaw', () => {
    const dir = lookDirection({ yaw: Math.PI / 2, pitch: 0 });
    expect(dir.x).toBeCloseTo(1);
    expect(dir.z).toBeCloseTo(0);
  });

  it('points straight up at pitch +pi/2', () => {
    const dir = lookDirection({ yaw: 0, pitch: Math.PI / 2 });
    expect(dir.y).toBeCloseTo(1);
    expect(dir.x).toBeCloseTo(0);
    expect(dir.z).toBeCloseTo(0);
  });
});

describe('aimYaw', () => {
  it('faces a target straight ahead on +z', () => {
    expect(aimYaw({ targetX: 0, targetZ: 5, fromX: 0, fromZ: 0 })).toBeCloseTo(0);
  });

  it('faces a target on +x with a quarter-turn', () => {
    expect(aimYaw({ targetX: 5, targetZ: 0, fromX: 0, fromZ: 0 })).toBeCloseTo(Math.PI / 2);
  });
});

describe('aimPitch', () => {
  it('is level for a target at the same height', () => {
    expect(aimPitch({ targetX: 5, targetY: 0, targetZ: 0, fromX: 0, fromY: 0, fromZ: 0 })).toBeCloseTo(0);
  });

  it('tilts up for a target above and equally far on x', () => {
    expect(aimPitch({ targetX: 1, targetY: 1, targetZ: 0, fromX: 0, fromY: 0, fromZ: 0 })).toBeCloseTo(Math.PI / 4);
  });

  it('tilts down for a target below', () => {
    expect(aimPitch({ targetX: 1, targetY: -1, targetZ: 0, fromX: 0, fromY: 0, fromZ: 0 })).toBeCloseTo(-Math.PI / 4);
  });
});
