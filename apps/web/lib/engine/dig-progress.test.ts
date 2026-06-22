import { describe, expect, it } from 'vitest';
import { chipTap, type Chip } from './dig-progress';

const DIG_HITS = 4;

describe('chipTap', () => {
  it('breaks only on the DIG_HITS-th tap on the same cell', () => {
    let chip: Chip | null = null;
    const results = Array.from({ length: DIG_HITS }, () => {
      const r = chipTap({ chip, x: 5, y: 6, z: 7, digHits: DIG_HITS });
      chip = r.chip;
      return r.broke;
    });
    expect(results).toEqual([false, false, false, true]);
  });

  it('clears the chip when it breaks so the next tap starts fresh', () => {
    let chip: Chip | null = { x: 5, y: 6, z: 7, taps: DIG_HITS - 1 };
    const broke = chipTap({ chip, x: 5, y: 6, z: 7, digHits: DIG_HITS });
    expect(broke).toEqual({ chip: null, broke: true });
  });

  it('resets the tap count when the player switches to a different cell', () => {
    const chip: Chip = { x: 5, y: 6, z: 7, taps: 3 };
    const r = chipTap({ chip, x: 5, y: 6, z: 8, digHits: DIG_HITS });
    expect(r).toEqual({ chip: { x: 5, y: 6, z: 8, taps: 1 }, broke: false });
  });

  it('starts counting from a null chip', () => {
    const r = chipTap({ chip: null, x: 0, y: 0, z: 0, digHits: DIG_HITS });
    expect(r).toEqual({ chip: { x: 0, y: 0, z: 0, taps: 1 }, broke: false });
  });
});
