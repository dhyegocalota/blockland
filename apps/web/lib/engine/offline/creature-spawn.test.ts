import { describe, expect, it } from 'vitest';
import { CREATURE_DEFS } from './creatures';
import { SPAWN_RANGE, STARTING_ROSTER, spawnPosition } from './creature-spawn';

describe('STARTING_ROSTER', () => {
  it('names only known creatures', () => {
    expect(STARTING_ROSTER.every((kind) => CREATURE_DEFS[kind])).toBe(true);
  });

  it('seeds the original mix', () => {
    const counts = STARTING_ROSTER.reduce<Record<string, number>>((acc, kind) => {
      acc[kind] = (acc[kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ pig: 3, chicken: 2, cow: 2, slime: 2, spider: 1 });
  });
});

describe('spawnPosition', () => {
  it('places a creature at the world centre with a neutral roll', () => {
    expect(spawnPosition({ sizeX: 1000, sizeZ: 1000, random: () => 0.5 })).toEqual({ x: 500, z: 500 });
  });

  it('offsets up to the spawn range', () => {
    const position = spawnPosition({ sizeX: 1000, sizeZ: 1000, random: () => 1 });
    expect(position.x).toBe(500 + SPAWN_RANGE);
  });

  it('keeps spawns off the world edge', () => {
    const position = spawnPosition({ sizeX: 10, sizeZ: 10, random: () => 0 });
    expect(position.x).toBe(2);
    expect(position.z).toBe(2);
  });
});
