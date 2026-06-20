import { describe, expect, it } from 'vitest';
import { moveVector, type MoveInput } from './movement';

const base: MoveInput = {
  yaw: 0,
  pitch: 0,
  fly: false,
  forward: false,
  back: false,
  left: false,
  right: false,
  joystickActive: false,
  joystickX: 0,
  joystickY: 0,
};

describe('moveVector', () => {
  it('is zero with no input', () => {
    expect(moveVector(base)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('walks forward along +z at yaw 0 (no vertical component)', () => {
    const v = moveVector({ ...base, forward: true });
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBe(0);
    expect(v.z).toBeCloseTo(1);
  });

  it('opposite keys cancel out', () => {
    expect(moveVector({ ...base, forward: true, back: true })).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('normalizes diagonal movement to unit length', () => {
    const v = moveVector({ ...base, forward: true, left: true });
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1);
  });

  it('flying forward while looking up adds a vertical component', () => {
    const v = moveVector({ ...base, fly: true, pitch: Math.PI / 4, forward: true });
    expect(v.y).toBeGreaterThan(0);
  });

  it('a forward joystick pushes forward (joystickY is negated)', () => {
    const v = moveVector({ ...base, joystickActive: true, joystickY: -1 });
    expect(v.z).toBeCloseTo(1);
  });
});
