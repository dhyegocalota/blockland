import { describe, expect, it } from 'vitest';
import { SIZE_Y } from './constants';
import { groundHeight } from './terrain-column';

describe('groundHeight', () => {
  it('returns the cell above the highest solid block', () => {
    expect(groundHeight({ isSolidAt: (y) => y <= 10 })).toBe(11);
  });

  it('returns zero for an empty column', () => {
    expect(groundHeight({ isSolidAt: () => false })).toBe(0);
  });

  it('honors a block at the very top of the world', () => {
    expect(groundHeight({ isSolidAt: (y) => y === SIZE_Y - 1 })).toBe(SIZE_Y);
  });
});
