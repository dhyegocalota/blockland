import { describe, expect, it } from 'vitest';
import {
  AIR,
  BEDROCK_ID,
  BLACK_ID,
  BLUE_ID,
  CELESTE_ID,
  CHUNK,
  CYAN_ID,
  DAMAGE_BLIP_DURATION,
  DAMAGE_BLIP_FREQ,
  DEFAULT_APP_VERSION,
  DIG_BLIP_DURATION,
  DIG_BLIP_FREQ,
  EYE_HEIGHT,
  FACE_ID,
  FLY_SPEED,
  GOLD_ID,
  GRASS_ID,
  GRAVITY,
  GROUND,
  HAIR_ID,
  HURT_COOLDOWN,
  HURT_FLASH_MS,
  JUMP_SPEED,
  MAX_FLY_Y,
  MAX_HEARTS,
  MOUSE_LOOK_SENSITIVITY,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  POS_SAVE_MS,
  REACH,
  RED_ID,
  RESPAWN_DELAY_MS,
  SAND_ID,
  SIZE_X,
  SIZE_Y,
  SIZE_Z,
  SKIN_ID,
  SPAWN_OFFSET_Z,
  STRUCTURE_REACH_DIST,
  TOAST_DURATION_MS,
  TOUCH_LOOK_SENSITIVITY,
  VOID_FALL_Y,
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

  it('keeps the flight ceiling above the column top', () => {
    expect(MAX_FLY_Y).toBeGreaterThan(SIZE_Y);
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

describe('engine-local tuning', () => {
  it('keeps the player tuning values', () => {
    expect(MAX_HEARTS).toBe(3);
    expect(HURT_COOLDOWN).toBe(1.2);
    expect(SPAWN_OFFSET_Z).toBe(4);
    expect(VOID_FALL_Y).toBe(-8);
  });

  it('keeps the persistence + loop cadence', () => {
    expect(POS_SAVE_MS).toBe(2000);
    expect(RESPAWN_DELAY_MS).toBe(4000);
    expect(DEFAULT_APP_VERSION).toBe('dev');
  });

  it('keeps the HUD timings', () => {
    expect(HURT_FLASH_MS).toBe(300);
    expect(TOAST_DURATION_MS).toBe(1200);
  });

  it('keeps the look sensitivities', () => {
    expect(MOUSE_LOOK_SENSITIVITY).toBe(0.0022);
    expect(TOUCH_LOOK_SENSITIVITY).toBe(0.005);
  });

  it('keeps the audio cues + structure reach', () => {
    expect(DAMAGE_BLIP_FREQ).toBe(140);
    expect(DAMAGE_BLIP_DURATION).toBe(0.18);
    expect(DIG_BLIP_FREQ).toBe(180);
    expect(DIG_BLIP_DURATION).toBe(0.05);
    expect(STRUCTURE_REACH_DIST).toBe(90);
  });
});
