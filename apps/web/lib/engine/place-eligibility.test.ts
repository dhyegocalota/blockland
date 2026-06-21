import { describe, expect, it } from 'vitest';
import { canPlaceSelected, shouldSpendBlock } from './place-eligibility';

describe('canPlaceSelected', () => {
  it('always allows placing with infinite resources', () => {
    expect(canPlaceSelected({ infiniteResources: true, count: 0 })).toBe(true);
  });

  it('allows placing when at least one is banked', () => {
    expect(canPlaceSelected({ infiniteResources: false, count: 1 })).toBe(true);
  });

  it('blocks placing when the bag is empty', () => {
    expect(canPlaceSelected({ infiniteResources: false, count: 0 })).toBe(false);
  });
});

describe('shouldSpendBlock', () => {
  it('does not spend with infinite resources', () => {
    expect(shouldSpendBlock({ infiniteResources: true })).toBe(false);
  });

  it('spends when resources are finite', () => {
    expect(shouldSpendBlock({ infiniteResources: false })).toBe(true);
  });
});
