import { describe, expect, it } from 'vitest';
import {
  DAMAGE_BLIP_DURATION, DAMAGE_BLIP_FREQ, DEFAULT_APP_VERSION, DIG_BLIP_DURATION, DIG_BLIP_FREQ,
  HURT_COOLDOWN, HURT_FLASH_MS, MAX_HEARTS, MOUSE_LOOK_SENSITIVITY, POS_SAVE_MS, RESPAWN_DELAY_MS,
  SPAWN_OFFSET_Z, STRUCTURE_REACH_DIST, TOAST_DURATION_MS, TOUCH_LOOK_SENSITIVITY, VOID_FALL_Y,
} from './engine-config';

describe('engine-config', () => {
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
