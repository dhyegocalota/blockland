// AUTO-GENERATED from apps/server/crates (sim + game-core). Do not edit.
// Regenerate with: cargo test -p game-core
// The Rust simulation is the single source of truth for these gameplay/physics/world
// constants; constants.ts re-exports them so client and server can never drift.

export const SIZE_X = 163840;
export const SIZE_Z = 163840;
export const SIZE_Y = 48;
export const CHUNK = 32;
export const GROUND = 10;
export const WATER_LEVEL = 9;
export const MAX_FLY_Y = 80;
export const DIG_HITS = 2;
export const MAX_HEARTS = 3;
export const EYE_HEIGHT = 1.55;
export const DEATH_FALL_MS = 900;
export const HURT_COOLDOWN = 1.2;
export const HEART_PICKUP_RADIUS = 1.4;
export const HEART_DROP_TTL_MS = 20000;
export const CREATURE_SEPARATION = 0.9;
export const CREATURE_STOP_DISTANCE = 0.65;
export const CREATURE_ORBIT_SPEED = 2.4;
export const CREATURE_ORBIT_FLIP_TICKS = 80;
export const SPAWN_OFFSET_Z = 4;
export const SPAWN_AREA_RADIUS = 12;
export const SPAWN_SEARCH_RADIUS = 6;
export const SPAWN_CLEARANCE_GAP = 1.2;

// Shared voxel block ids — the ids the worldgen and world edits encode. The client-only
// palette ids and naming aliases stay hand-written in constants.ts; these are the shared set.
export const AIR = 0;
export const GRASS_ID = 1;
export const DIRT_ID = 2;
export const STONE_ID = 3;
export const WOOD_ID = 4;
export const LEAF_ID = 5;
export const SAND_ID = 6;
export const GOLD_ID = 8;
export const FACE_ID = 10;
export const WATER_ID = 11;
export const WHITE_ID = 12;
export const BEDROCK_ID = 16;
