// All pure engine constants — world dimensions, physics, block ids, and the engine-local tuning
// (player hearts, spawn offset, look sensitivity, HUD timings, audio cues, loop cadence, structure
// reach). No three.js, no DOM; the three.js/DOM glue used to spell these inline.

// ---------- World dimensions ----------
// SIZE_X / SIZE_Z mirror the Rust sim's WORLD_SIZE so client bounds match the authoritative server.
export const SIZE_X = 163840;
export const SIZE_Z = 163840;
export const SIZE_Y = 48;
export const CHUNK = 32;
export const GROUND = 10;
export const WATER_LEVEL = GROUND - 1;
// Hard flight ceiling enforced on both client and server so a flying player can never leave the
// playable column and bug the simulation.
export const MAX_FLY_Y = SIZE_Y + 32;

// ---------- Physics ----------
export const GRAVITY = -26;
export const JUMP_SPEED = 8.6;
export const WALK_SPEED = 5.4;
export const FLY_SPEED = 9;
export const PLAYER_RADIUS = 0.3;
export const PLAYER_HEIGHT = 1.7;
export const EYE_HEIGHT = 1.55;
export const REACH = 7;
// Taps on the same block before it breaks — digging takes a little effort. Mirrors the Rust server's
// DIG_HITS so an offline dig takes exactly as many taps as a co-op dig.
export const DIG_HITS = 2;
// Cadence of hold-to-attack: while the attack button is held, primaryAction() fires this often (4/sec).
// The Rust server enforces the same cadence (ATTACK_MIN_INTERVAL, slightly more lenient for jitter) so a
// modified client can't spam faster than a legit hold.
export const ATTACK_REPEAT_MS = 250;

// ---------- Block ids ----------
export const AIR = 0;
export const GRASS_ID = 1;
export const HAIR_ID = 2;
export const DIRT_ID = 2;
export const STONE_ID = 3;
export const WOOD_ID = 4;
export const LEAF_ID = 5;
export const SAND_ID = 6;
export const SKIN_ID = 6;
export const GOLD_ID = 8;
export const FACE_ID = 10;
export const WATER_ID = 11;
export const WHITE_ID = 12;
export const BLACK_ID = 13;
export const CYAN_ID = 14;
export const BEDROCK_ID = 16;
export const CELESTE_ID = 17;
export const RED_ID = 18;
export const BLUE_ID = 19;

// ---------- Player ----------
export const MAX_HEARTS = 3;
// Invulnerability window after a monster bite (seconds), so a single touch can't drain every heart.
export const HURT_COOLDOWN = 1.2;
// A defeated creature drops a heart pickup: a player within this radius of it who is below MAX_HEARTS
// collects it for +1 heart. Mirrors the Rust server's PICKUP_RADIUS.
export const HEART_PICKUP_RADIUS = 1.4;
// A dropped heart vanishes after this long if nobody collects it, so drops never accumulate. Mirrors
// the Rust server's HEART_DROP_TTL_MS.
export const HEART_DROP_TTL_MS = 20000;
// A dropped heart hovers this far above its base position and bobs at this rate (radians/sec).
export const HEART_BOB_HEIGHT = 0.18;
export const HEART_BOB_SPEED = 3;
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
