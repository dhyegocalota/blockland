import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS, SENSITIVITY_MAX, SENSITIVITY_MIN, SETTINGS_KEY, VOLUME_MAX, VOLUME_MIN,
  escapeKeyAction, getSettings, loadSettings, lookDelta, saveSettings, scaledGain, shouldOpenOnLockLost, subscribeSettings, updateSettings,
} from './settings';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.resetModules();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    location: { search: '' },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('settings load/save', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a saved settings object', () => {
    const settings = { mouseSensitivity: 1.5, touchSensitivity: 0.8, volume: 0.4, muted: true };
    saveSettings(settings);
    expect(loadSettings()).toEqual(settings);
  });

  it('falls back to defaults for malformed json', () => {
    store.set(SETTINGS_KEY, 'not json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('fills missing fields from defaults', () => {
    store.set(SETTINGS_KEY, JSON.stringify({ volume: 0.5 }));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, volume: 0.5 });
  });

  it('clamps out-of-range values on load and save', () => {
    store.set(SETTINGS_KEY, JSON.stringify({ mouseSensitivity: 99, touchSensitivity: -5, volume: 9 }));
    expect(loadSettings()).toEqual({
      mouseSensitivity: SENSITIVITY_MAX,
      touchSensitivity: SENSITIVITY_MIN,
      volume: VOLUME_MAX,
      muted: false,
    });
    saveSettings({ mouseSensitivity: 0, touchSensitivity: 0, volume: -1, muted: false });
    expect(loadSettings().volume).toBe(VOLUME_MIN);
    expect(loadSettings().mouseSensitivity).toBe(SENSITIVITY_MIN);
  });
});

describe('live store', () => {
  it('updates persist and notify subscribers with the clamped value', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeSettings((s) => seen.push(s.volume));
    updateSettings({ volume: 0.3 });
    expect(getSettings().volume).toBe(0.3);
    expect(loadSettings().volume).toBe(0.3);
    expect(seen).toEqual([0.3]);
    updateSettings({ volume: 5 });
    expect(getSettings().volume).toBe(VOLUME_MAX);
    expect(seen).toEqual([0.3, VOLUME_MAX]);
    unsubscribe();
    updateSettings({ volume: 0.1 });
    expect(seen).toEqual([0.3, VOLUME_MAX]);
  });
});

describe('scaledGain', () => {
  it('leaves the base gain untouched at full volume (today\'s level)', () => {
    expect(scaledGain(0.06, { ...DEFAULT_SETTINGS })).toBeCloseTo(0.06);
  });

  it('scales the gain by volume', () => {
    expect(scaledGain(0.06, { ...DEFAULT_SETTINGS, volume: 0.5 })).toBeCloseTo(0.03);
  });

  it('silences the cue when muted', () => {
    expect(scaledGain(0.06, { ...DEFAULT_SETTINGS, muted: true })).toBe(0);
  });
});

describe('lookDelta', () => {
  it('is the unchanged base delta at multiplier 1.0', () => {
    expect(lookDelta(10, 0.0022, 1)).toBeCloseTo(0.022);
  });

  it('scales the delta by the multiplier', () => {
    expect(lookDelta(10, 0.0022, 2)).toBeCloseTo(0.044);
    expect(lookDelta(10, 0.0022, 0.5)).toBeCloseTo(0.011);
  });
});

describe('shouldOpenOnLockLost (Esc-to-pause decision)', () => {
  it('opens the settings menu when a mouse game loses its lock with no modal up', () => {
    expect(shouldOpenOnLockLost({ started: true, isTouch: false, anyModalOpen: false })).toBe(true);
  });

  it('never opens before the game starts, on touch, or when another modal already paused', () => {
    expect(shouldOpenOnLockLost({ started: false, isTouch: false, anyModalOpen: false })).toBe(false);
    expect(shouldOpenOnLockLost({ started: true, isTouch: true, anyModalOpen: false })).toBe(false);
    expect(shouldOpenOnLockLost({ started: true, isTouch: false, anyModalOpen: true })).toBe(false);
  });
});

describe('escapeKeyAction (Esc closes the open modal and re-locks; controls/build take priority)', () => {
  const playing = { started: true, isTouch: false, pointerLocked: false };

  it('closes the controls modal (never opening settings), then build, by priority', () => {
    expect(escapeKeyAction({ ...playing, controlsOpen: true, buildOpen: false, settingsOpen: false })).toBe('close-controls');
    expect(escapeKeyAction({ ...playing, controlsOpen: false, buildOpen: true, settingsOpen: false })).toBe('close-build');
    expect(escapeKeyAction({ ...playing, controlsOpen: true, buildOpen: true, settingsOpen: true })).toBe('close-controls');
  });

  it('closes the settings panel when it is the only thing open', () => {
    expect(escapeKeyAction({ ...playing, controlsOpen: false, buildOpen: false, settingsOpen: true })).toBe('close-settings');
  });

  it('does nothing while still locked (PLAYING — pointerlockchange owns the first Esc), on touch, before start, or with nothing open', () => {
    expect(escapeKeyAction({ ...playing, pointerLocked: true, controlsOpen: false, buildOpen: false, settingsOpen: true })).toBe('none');
    expect(escapeKeyAction({ ...playing, isTouch: true, controlsOpen: true, buildOpen: false, settingsOpen: false })).toBe('none');
    expect(escapeKeyAction({ ...playing, started: false, controlsOpen: true, buildOpen: false, settingsOpen: false })).toBe('none');
    expect(escapeKeyAction({ ...playing, controlsOpen: false, buildOpen: false, settingsOpen: false })).toBe('none');
  });
});

// Mirror the exact expressions the engine glue evaluates (game-loop look math + hud blip gain), reading
// the live store so a slider move applies immediately — the integration the engine relies on.
describe('engine wiring through the live store', () => {
  const MOUSE_LOOK_SENSITIVITY = 0.0022;
  const BLIP_BASE_GAIN = 0.06;

  beforeEach(() => { updateSettings({ ...DEFAULT_SETTINGS }); });

  it('the look math is byte-identical to the old fixed const at the default multiplier', () => {
    const movementX = 12;
    const old = movementX * MOUSE_LOOK_SENSITIVITY;
    expect(lookDelta(movementX, MOUSE_LOOK_SENSITIVITY, getSettings().mouseSensitivity)).toBe(old);
  });

  it('a live sensitivity update changes the next look delta', () => {
    updateSettings({ mouseSensitivity: 2 });
    expect(lookDelta(12, MOUSE_LOOK_SENSITIVITY, getSettings().mouseSensitivity)).toBeCloseTo(12 * MOUSE_LOOK_SENSITIVITY * 2);
  });

  it('the cue gain is unchanged at default volume but a live mute silences it', () => {
    expect(scaledGain(BLIP_BASE_GAIN, getSettings())).toBeCloseTo(BLIP_BASE_GAIN);
    updateSettings({ muted: true });
    expect(scaledGain(BLIP_BASE_GAIN, getSettings())).toBe(0);
  });
});
