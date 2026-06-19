// Pure world, physics, and block-id constants. No three.js, no DOM.

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

// ---------- World bounds ----------
// Keep a position inside the horizontal world and under the flight ceiling, matching the server's
// move validation so the client never sends an out-of-bounds position.
export function clampToWorld(position: { x: number; y: number; z: number }): void {
  position.x = Math.max(0, Math.min(SIZE_X, position.x));
  position.z = Math.max(0, Math.min(SIZE_Z, position.z));
  position.y = Math.min(MAX_FLY_Y, position.y);
}
