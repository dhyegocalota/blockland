import { describe, expect, it } from 'vitest';
import { clampPitch } from './binds';

describe('clampPitch', () => {
  it('keeps a pitch inside the look range untouched', () => {
    expect(clampPitch(0.5)).toBe(0.5);
    expect(clampPitch(-0.5)).toBe(-0.5);
  });

  it('clamps to straight up and straight down', () => {
    expect(clampPitch(3)).toBe(1.5);
    expect(clampPitch(-3)).toBe(-1.5);
  });
});
