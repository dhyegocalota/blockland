import { describe, expect, it } from 'vitest';
import { heartBobOffset } from './heart-drop';

describe('heartBobOffset', () => {
  it('rests at zero at t=0 and stays bounded', () => {
    expect(heartBobOffset(0)).toBe(0);
    expect(Math.abs(heartBobOffset(123.4))).toBeLessThanOrEqual(0.18);
  });
});
