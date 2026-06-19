// Pure world, physics, and block-id constants. No three.js, no DOM.

// ---------- World dimensions ----------
export const SIZE_X = 16384;
export const SIZE_Z = 16384;
export const SIZE_Y = 24;
export const CHUNK = 32;
export const GROUND = 6;
export const WATER_LEVEL = GROUND - 1;

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
export const WOOD_ID = 4;
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
