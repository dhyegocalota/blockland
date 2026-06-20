import { describe, expect, it } from 'vitest';
import {
  KNOCKBACK_DISTANCE, bobOffset, creatureBitesPlayer, knockbackVector, stepCreaturePosition,
} from './creature-combat';

describe('bobOffset', () => {
  it('peaks at the bob height', () => {
    expect(bobOffset(Math.PI / 2)).toBeCloseTo(0.12);
  });

  it('never goes below zero', () => {
    expect(bobOffset(Math.PI)).toBeCloseTo(0);
  });
});

describe('creatureBitesPlayer', () => {
  it('bites when close and level', () => {
    expect(creatureBitesPlayer({ horizontalDistance: 0.5, verticalGap: 1 })).toBe(true);
  });

  it('misses when too far away', () => {
    expect(creatureBitesPlayer({ horizontalDistance: 1.5, verticalGap: 0 })).toBe(false);
  });

  it('misses when on a different level', () => {
    expect(creatureBitesPlayer({ horizontalDistance: 0.5, verticalGap: 2 })).toBe(false);
  });
});

describe('stepCreaturePosition', () => {
  it('moves along the facing direction', () => {
    const next = stepCreaturePosition({ x: 50, z: 50, dir: Math.PI / 2, speed: 2, dt: 1, sizeX: 100, sizeZ: 100 });
    expect(next.x).toBeCloseTo(52);
    expect(next.z).toBeCloseTo(50);
  });

  it('keeps the creature inside the world edges', () => {
    const next = stepCreaturePosition({ x: 0, z: 0, dir: -Math.PI / 2, speed: 10, dt: 1, sizeX: 100, sizeZ: 100 });
    expect(next.x).toBe(1);
  });
});

describe('knockbackVector', () => {
  it('shoves away from the player at a fixed distance', () => {
    const knock = knockbackVector({ creatureX: 3, creatureZ: 0, playerX: 0, playerZ: 0 });
    expect(knock.x).toBeCloseTo(KNOCKBACK_DISTANCE);
    expect(knock.z).toBeCloseTo(0);
  });

  it('is zero when exactly overlapping', () => {
    expect(knockbackVector({ creatureX: 1, creatureZ: 1, playerX: 1, playerZ: 1 })).toEqual({ x: 0, z: 0 });
  });
});
