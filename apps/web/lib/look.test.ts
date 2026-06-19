import { describe, it, expect } from 'vitest';
import { LOOK_PALETTES, randomLook } from './look';

describe('randomLook', () => {
  it('always picks each part from its own palette', () => {
    for (let i = 0; i < 60; i++) {
      const look = randomLook();
      expect(LOOK_PALETTES.skin).toContain(look.skin);
      expect(LOOK_PALETTES.shirt).toContain(look.shirt);
      expect(LOOK_PALETTES.hair).toContain(look.hair);
    }
  });

  it('varies across calls (not always the default look)', () => {
    const shirts = new Set(Array.from({ length: 40 }, () => randomLook().shirt));
    expect(shirts.size).toBeGreaterThan(1);
  });
});
