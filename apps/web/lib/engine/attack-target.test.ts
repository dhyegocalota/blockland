import { describe, expect, it } from 'vitest';
import { chooseCoopTarget, chooseLocalTarget } from './attack-target';

describe('chooseLocalTarget', () => {
  it('hits a creature in front of the block', () => {
    expect(chooseLocalTarget({ creatureT: 3, blockDistance: 5, hasBlock: true })).toBe('creature');
  });

  it('breaks the block when the creature is behind it', () => {
    expect(chooseLocalTarget({ creatureT: 6, blockDistance: 5, hasBlock: true })).toBe('block');
  });

  it('breaks the block when nothing else is aimed at', () => {
    expect(chooseLocalTarget({ creatureT: null, blockDistance: 4, hasBlock: true })).toBe('block');
  });

  it('does nothing when the crosshair is empty', () => {
    expect(chooseLocalTarget({ creatureT: null, blockDistance: Infinity, hasBlock: false })).toBe('none');
  });
});

describe('chooseCoopTarget', () => {
  it('prefers a remote player at equal range', () => {
    expect(chooseCoopTarget({ playerT: 3, creatureT: 3, blockDistance: 5, hasBlock: true })).toBe('player');
  });

  it('falls back to a closer creature', () => {
    expect(chooseCoopTarget({ playerT: 4, creatureT: 2, blockDistance: 5, hasBlock: true })).toBe('creature');
  });

  it('breaks the block when both are behind it', () => {
    expect(chooseCoopTarget({ playerT: 6, creatureT: 7, blockDistance: 5, hasBlock: true })).toBe('block');
  });

  it('does nothing on an empty crosshair', () => {
    expect(chooseCoopTarget({ playerT: null, creatureT: null, blockDistance: Infinity, hasBlock: false })).toBe('none');
  });
});
