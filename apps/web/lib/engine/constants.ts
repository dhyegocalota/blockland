// Pure engine constants — world dimensions, physics, block ids, and the engine-local tuning
// (player hearts, spawn offset, look sensitivity, HUD timings, audio cues, loop cadence, structure
// reach). No three.js, no DOM; the three.js/DOM glue used to spell these inline.
//
// The gameplay/physics/world values the authoritative Rust server also owns are NOT defined here:
// they are generated into `constants.gen.ts` from the Rust source (sim + game-core) and re-exported
// below, so client and server can never silently drift. Regenerate with `cargo test -p game-core`.

export {
  CHUNK,
  CREATURE_ORBIT_FLIP_TICKS,
  CREATURE_ORBIT_SPEED,
  CREATURE_SEPARATION,
  CREATURE_STOP_DISTANCE,
  DIG_HITS,
  GROUND,
  HEART_DROP_TTL_MS,
  HEART_PICKUP_RADIUS,
  HURT_COOLDOWN,
  MAX_FLY_Y,
  MAX_HEARTS,
  SIZE_X,
  SIZE_Y,
  SIZE_Z,
  SPAWN_AREA_RADIUS,
  SPAWN_CLEARANCE_GAP,
  SPAWN_OFFSET_Z,
  SPAWN_SEARCH_RADIUS,
  WATER_LEVEL,
} from './constants.gen';

// ---------- Physics ----------
export const GRAVITY = -26;
export const JUMP_SPEED = 8.6;
export const WALK_SPEED = 5.4;
export const FLY_SPEED = 9;
export const PLAYER_RADIUS = 0.3;
export const PLAYER_HEIGHT = 1.7;
export const EYE_HEIGHT = 1.55;
export const REACH = 7;
// Cadence of hold-to-attack: while the attack button is held, primaryAction() fires this often (4/sec).
// The Rust server enforces a matching cadence (ATTACK_MIN_INTERVAL, slightly more lenient for jitter) so a
// modified client can't spam faster than a legit hold.
export const ATTACK_REPEAT_MS = 250;

// How long one attack swing animation lasts: the held tool (first-person) and the avatar arm (third-
// person) rotate forward then ease back over this window. Kept shorter than ATTACK_REPEAT_MS so a held
// attack retriggers a fresh swing on every tap instead of stacking.
export const SWING_DURATION_MS = 220;
// Peak forward rotation of a swing, in radians (~46°): the angle the tool/arm reaches at the apex.
export const SWING_PEAK_RAD = 0.8;

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
// A defeated creature drops a heart pickup that hovers this far above its base position and bobs at this
// rate (radians/sec); the drop's radius/ttl come from the generated server constants.
export const HEART_BOB_HEIGHT = 0.18;
export const HEART_BOB_SPEED = 3;
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
