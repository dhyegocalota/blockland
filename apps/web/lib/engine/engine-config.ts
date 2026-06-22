// Engine-local magic numbers: the tuning that lives only in the three.js/DOM glue (player hearts,
// spawn offset, look sensitivity, HUD timings, audio cues, loop cadence). World/physics/block-id
// constants live in constants.ts; these are the values game-engine.ts used to spell inline.

// ---------- Player ----------
export const MAX_HEARTS = 3;
// Invulnerability window after a monster bite (seconds), so a single touch can't drain every heart.
export const HURT_COOLDOWN = 1.2;
// The spawn point sits this many cells south of the world centre (so the player faces the monument).
export const SPAWN_OFFSET_Z = 4;
// Fall below this Y (under the world floor) and the player is teleported back to spawn.
export const VOID_FALL_Y = -8;

// ---------- Persistence + loop cadence ----------
// How often the player's position is persisted to localStorage while playing (ms).
export const POS_SAVE_MS = 2000;
// Delay before a defeated creature respawns (ms).
export const RESPAWN_DELAY_MS = 4000;
// Web build identifier shown in the debug panel when running locally (no deploy SHA injected).
export const DEFAULT_APP_VERSION = 'dev';

// ---------- HUD timings (ms) ----------
export const HURT_FLASH_MS = 300;
export const TOAST_DURATION_MS = 1200;

// ---------- Look sensitivity ----------
// Radians of yaw/pitch per pixel of pointer/touch movement.
export const MOUSE_LOOK_SENSITIVITY = 0.0022;
export const TOUCH_LOOK_SENSITIVITY = 0.005;

// ---------- Audio cues (frequency Hz, duration s) ----------
export const DAMAGE_BLIP_FREQ = 140;
export const DAMAGE_BLIP_DURATION = 0.18;
export const DIG_BLIP_FREQ = 180;
export const DIG_BLIP_DURATION = 0.05;
// A two-note rising cue played when a room-wide event lands (world reset, scores reset, suspend).
export const CHIME_LOW_FREQ = 587;
export const CHIME_HIGH_FREQ = 880;
export const CHIME_NOTE_DURATION = 0.12;
export const CHIME_GAP_MS = 110;

// ---------- Structures ----------
// Reach for aiming a magic structure (longer than block REACH so you can place one across a clearing).
export const STRUCTURE_REACH_DIST = 90;
