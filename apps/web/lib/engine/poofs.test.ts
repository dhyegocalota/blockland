import { describe, expect, it } from 'vitest';
import { POOF_GRAVITY, POOF_LIFE, spawnPoofVelocity, stepPoof } from './poofs';

describe('spawnPoofVelocity', () => {
  it('launches sideways within range and always upward', () => {
    const velocity = spawnPoofVelocity(() => 0.5);
    expect(velocity.x).toBe(0);
    expect(velocity.z).toBe(0);
    expect(velocity.y).toBe(3);
  });

  it('keeps the upward burst positive at the low end', () => {
    const velocity = spawnPoofVelocity(() => 0);
    expect(velocity.y).toBe(1);
    expect(velocity.x).toBe(-2);
  });
});

describe('stepPoof', () => {
  it('pulls velocity down by gravity and shrinks', () => {
    const step = stepPoof({ life: POOF_LIFE, velocityY: 4, dt: 0.1 });
    expect(step.velocityY).toBeCloseTo(4 - POOF_GRAVITY * 0.1);
    expect(step.scaleFactor).toBeCloseTo(1 - 0.1 * 1.5);
    expect(step.dead).toBe(false);
  });

  it('dies once life reaches zero', () => {
    const step = stepPoof({ life: 0.05, velocityY: 0, dt: 0.05 });
    expect(step.life).toBeCloseTo(0);
    expect(step.dead).toBe(true);
  });
});
