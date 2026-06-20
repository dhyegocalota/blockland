import { describe, expect, it } from 'vitest';
import { bestScore, EMPTY_HEART, FULL_HEART, heartsLabel, roundCoordinate } from './scoreboard';

describe('heartsLabel', () => {
  it('fills the remaining hearts as empty', () => {
    expect(heartsLabel({ hearts: 2, maxHearts: 3 })).toBe(FULL_HEART.repeat(2) + EMPTY_HEART);
  });

  it('shows all empty at zero', () => {
    expect(heartsLabel({ hearts: 0, maxHearts: 3 })).toBe(EMPTY_HEART.repeat(3));
  });
});

describe('bestScore', () => {
  it('keeps the higher of the run and the stored record', () => {
    expect(bestScore({ stars: 5, stored: 12 })).toBe(12);
    expect(bestScore({ stars: 20, stored: 12 })).toBe(20);
  });
});

describe('roundCoordinate', () => {
  it('rounds to two decimals', () => {
    expect(roundCoordinate(1.23456)).toBe(1.23);
    expect(roundCoordinate(-0.005)).toBe(-0);
  });
});
