// Per-device player settings (audio + look sensitivity), persisted to localStorage under `bl-settings`
// like `bl-session`/`bl-name`. A single live store the engine reads every frame (look math) and every
// cue (audio gain), so a slider move applies immediately with no reload. Pure: the load/save round-trip,
// the clamps and the gain/look scaling helpers are all unit-tested; the engine glue just calls them.
import { debug } from './log';

export const SETTINGS_KEY = 'bl-settings';

export interface Settings {
  // Multipliers over the base look constants: 1.0 = today's feel, clamped to a kid-safe range.
  mouseSensitivity: number;
  touchSensitivity: number;
  // Master volume 0..1 (1 = today's level) and a hard mute that gates every cue to silence.
  volume: number;
  muted: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  mouseSensitivity: 1,
  touchSensitivity: 1,
  volume: 1,
  muted: false,
};

export const SENSITIVITY_MIN = 0.25;
export const SENSITIVITY_MAX = 3;
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitize(raw: Partial<Settings>): Settings {
  const mouse = typeof raw.mouseSensitivity === 'number' ? raw.mouseSensitivity : DEFAULT_SETTINGS.mouseSensitivity;
  const touch = typeof raw.touchSensitivity === 'number' ? raw.touchSensitivity : DEFAULT_SETTINGS.touchSensitivity;
  const vol = typeof raw.volume === 'number' ? raw.volume : DEFAULT_SETTINGS.volume;
  return {
    mouseSensitivity: clamp(mouse, SENSITIVITY_MIN, SENSITIVITY_MAX),
    touchSensitivity: clamp(touch, SENSITIVITY_MIN, SENSITIVITY_MAX),
    volume: clamp(vol, VOLUME_MIN, VOLUME_MAX),
    muted: raw.muted === true,
  };
}

export function loadSettings(): Settings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
  const raw = window.localStorage.getItem(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return sanitize(JSON.parse(raw) as Partial<Settings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitize(settings)));
}

// The single live store the engine reads. Initialized lazily from localStorage on first access so the
// module is safe to import server-side (the loader/lobby never touches it before the browser is up).
let current: Settings | null = null;
const listeners = new Set<(settings: Settings) => void>();

export function getSettings(): Settings {
  if (!current) current = loadSettings();
  return current;
}

// Apply a partial change, persist it, and notify subscribers (the React panel re-renders from it). Every
// field is re-clamped so a stray value can never poison the live store.
export function updateSettings(patch: Partial<Settings>): Settings {
  const next = sanitize({ ...getSettings(), ...patch });
  current = next;
  saveSettings(next);
  debug('settings', 'updated', {
    mouseSensitivity: next.mouseSensitivity,
    touchSensitivity: next.touchSensitivity,
    volume: next.volume,
    muted: next.muted,
  });
  listeners.forEach((listener) => listener(next));
  return next;
}

export function subscribeSettings(listener: (settings: Settings) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// The effective cue gain: the base oscillator gain scaled by master volume, or silence when muted.
export function scaledGain(baseGain: number, settings: Settings): number {
  if (settings.muted) return 0;
  return baseGain * settings.volume;
}

// Yaw/pitch delta for one pointer/touch move: the base radians-per-pixel sensitivity times the player's
// multiplier (1.0 = unchanged feel).
export function lookDelta(movement: number, baseSensitivity: number, multiplier: number): number {
  return movement * baseSensitivity * multiplier;
}

// Esc natively drops pointer lock (and can't be preventDefault'd in an FPS), so a lost lock is the pause
// signal: open the settings menu only when the game is actually playing on a mouse (not touch) and no
// other modal already owns the pause. The hud `pointerlockchange` handler defers this decision here.
export function shouldOpenOnLockLost(args: { started: boolean; isTouch: boolean; anyModalOpen: boolean }): boolean {
  if (!args.started) return false;
  if (args.isTouch) return false;
  if (args.anyModalOpen) return false;
  return true;
}

// Esc while the pointer is UNLOCKED (paused) means "go back to the game": close the settings panel and
// re-lock → PLAYING (refocus). So a 1st Esc from playing unlocks + opens settings, and a 2nd Esc closes
// it + refocuses — the round-trip the player expects. Gated to a started mouse game with the pointer
// unlocked and no blocking controls/build modal owning Escape (those re-lock on their own close).
export function shouldResumeOnEscape(args: { started: boolean; isTouch: boolean; pointerLocked: boolean; blockingModalOpen: boolean }): boolean {
  if (!args.started) return false;
  if (args.isTouch) return false;
  if (args.pointerLocked) return false;
  if (args.blockingModalOpen) return false;
  return true;
}
