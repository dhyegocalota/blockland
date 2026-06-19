import { describe, expect, it } from 'vitest';
import {
  AIR,
  BEDROCK_ID,
  BLACK_ID,
  BLUE_ID,
  CELESTE_ID,
  CHUNK,
  CYAN_ID,
  EYE_HEIGHT,
  FACE_ID,
  FLY_SPEED,
  GOLD_ID,
  GRASS_ID,
  GRAVITY,
  GROUND,
  HAIR_ID,
  JUMP_SPEED,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  REACH,
  RED_ID,
  SAND_ID,
  SIZE_X,
  SIZE_Y,
  SIZE_Z,
  SKIN_ID,
  WALK_SPEED,
  WATER_ID,
  WATER_LEVEL,
  WHITE_ID,
  WOOD_ID,
} from './constants';

describe('world dimensions', () => {
  it('are positive integers', () => {
    [SIZE_X, SIZE_Z, SIZE_Y, CHUNK, GROUND].forEach((value) => {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    });
  });

  it('uses a square horizontal world', () => {
    expect(SIZE_X).toBe(SIZE_Z);
  });

  it('has horizontal extents divisible by the chunk size', () => {
    expect(SIZE_X % CHUNK).toBe(0);
    expect(SIZE_Z % CHUNK).toBe(0);
  });

  it('fits the ground and water level inside the vertical column', () => {
    expect(GROUND).toBeLessThan(SIZE_Y);
    expect(WATER_LEVEL).toBeLessThan(GROUND);
    expect(WATER_LEVEL).toBeGreaterThanOrEqual(0);
  });

  it('derives the water level one below ground', () => {
    expect(WATER_LEVEL).toBe(GROUND - 1);
  });
});

describe('physics constants', () => {
  it('pulls the player downward', () => {
    expect(GRAVITY).toBeLessThan(0);
  });

  it('has positive jump and movement speeds', () => {
    [JUMP_SPEED, WALK_SPEED, FLY_SPEED].forEach((speed) => {
      expect(speed).toBeGreaterThan(0);
    });
  });

  it('flies faster than it walks', () => {
    expect(FLY_SPEED).toBeGreaterThan(WALK_SPEED);
  });

  it('keeps the player body and eye dimensions sane', () => {
    expect(PLAYER_RADIUS).toBeGreaterThan(0);
    expect(PLAYER_HEIGHT).toBeGreaterThan(0);
    expect(EYE_HEIGHT).toBeGreaterThan(0);
    expect(EYE_HEIGHT).toBeLessThan(PLAYER_HEIGHT);
  });

  it('has a positive reach distance', () => {
    expect(REACH).toBeGreaterThan(0);
  });
});

describe('block ids', () => {
  const namedIds: Record<string, number> = {
    AIR,
    GRASS_ID,
    HAIR_ID,
    WOOD_ID,
    SAND_ID,
    SKIN_ID,
    GOLD_ID,
    FACE_ID,
    WATER_ID,
    WHITE_ID,
    BLACK_ID,
    CYAN_ID,
    BEDROCK_ID,
    CELESTE_ID,
    RED_ID,
    BLUE_ID,
  };

  it('reserves zero for air', () => {
    expect(AIR).toBe(0);
  });

  it('pins the well-known ids the glue depends on', () => {
    expect(FACE_ID).toBe(10);
    expect(WATER_ID).toBe(11);
    expect(BEDROCK_ID).toBe(16);
  });

  it('keeps every solid block id above air', () => {
    Object.entries(namedIds)
      .filter(([name]) => name !== 'AIR')
      .forEach(([, id]) => {
        expect(id).toBeGreaterThan(AIR);
      });
  });

  it('uses non-negative integers for every id', () => {
    Object.values(namedIds).forEach((id) => {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(0);
    });
  });

  it('shares a single id between sand and skin by design', () => {
    expect(SAND_ID).toBe(SKIN_ID);
    expect(SAND_ID).toBe(6);
  });

  it('keeps all other block ids distinct', () => {
    const distinctById = Object.entries(namedIds).filter(
      ([name]) => name !== 'SKIN_ID',
    );
    const ids = distinctById.map(([, id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
