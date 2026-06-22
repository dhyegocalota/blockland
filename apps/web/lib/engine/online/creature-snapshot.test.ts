import { describe, expect, it } from 'vitest';
import { CREATURE_DEFS } from '../offline/creatures';
import { creatureDefFor, creatureNameKey } from './creature-snapshot';

describe('creatureDefFor', () => {
  it('maps every known kind slug to its definition', () => {
    for (const kind of Object.keys(CREATURE_DEFS)) {
      expect(creatureDefFor(kind)).toBe(CREATURE_DEFS[kind]);
    }
  });

  it('throws on an unknown kind', () => {
    expect(() => creatureDefFor('dragon')).toThrow(/unknown creature kind dragon/);
  });
});

describe('creatureNameKey', () => {
  it('returns the i18n name key for a kind', () => {
    expect(creatureNameKey('pig')).toBe('creature.pig');
    expect(creatureNameKey('spider')).toBe('creature.spider');
  });
});
