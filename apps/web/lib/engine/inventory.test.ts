import { describe, expect, it } from 'vitest';
import { BlockInventory, hotbarCountLabel } from './inventory';

describe('BlockInventory', () => {
  it('starts every id at zero and cannot place', () => {
    const inventory = new BlockInventory();
    expect(inventory.count(1)).toBe(0);
    expect(inventory.canPlace(1)).toBe(false);
  });

  it('banks one per mine and spends one per place', () => {
    const inventory = new BlockInventory();
    inventory.bank(3);
    inventory.bank(3);
    expect(inventory.count(3)).toBe(2);
    expect(inventory.canPlace(3)).toBe(true);
    inventory.spend(3);
    expect(inventory.count(3)).toBe(1);
  });

  it('keeps counts per id independent', () => {
    const inventory = new BlockInventory();
    inventory.bank(1);
    expect(inventory.count(2)).toBe(0);
  });

  it('throws when spending with none banked', () => {
    const inventory = new BlockInventory();
    expect(() => inventory.spend(1)).toThrow();
  });

  it('reset empties every banked count', () => {
    const inventory = new BlockInventory();
    inventory.bank(1);
    inventory.bank(2);
    inventory.reset();
    expect(inventory.count(1)).toBe(0);
    expect(inventory.count(2)).toBe(0);
    expect(inventory.canPlace(1)).toBe(false);
  });
});

describe('hotbarCountLabel', () => {
  it('hides the badge when resources are infinite', () => {
    expect(hotbarCountLabel({ infiniteResources: true, count: 5 })).toBe('');
  });

  it('shows the banked count when constrained', () => {
    expect(hotbarCountLabel({ infiniteResources: false, count: 5 })).toBe('5');
  });
});
