// Pure rule for when a server-synced monster may damage the local player: it must be close, at the
// player's level (never lurking below the floor), and out in the open — a player can only be hit by a
// monster they can actually see, not one buried inside a block. The caller supplies the buried probe
// (it needs the world); everything else is geometry, kept here and unit-tested.

export const HURT_RANGE = 1.2;
// How far below the player's feet a monster may still count as "at your level".
export const HURT_LEVEL_SLACK = 0.5;
// Vertical offset above the monster centre to probe for a covering block (the "buried" test).
export const HURT_BURIED_PROBE = 0.4;

export function canMonsterReachPlayer(args: {
  monster: { x: number; y: number; z: number };
  playerX: number;
  playerFeetY: number;
  playerZ: number;
  playerHeight: number;
  buried: boolean;
}): boolean {
  const { monster, playerX, playerFeetY, playerZ, playerHeight, buried } = args;
  if (Math.hypot(playerX - monster.x, playerZ - monster.z) >= HURT_RANGE) return false;
  if (monster.y < playerFeetY - HURT_LEVEL_SLACK) return false;
  if (monster.y > playerFeetY + playerHeight) return false;
  if (buried) return false;
  return true;
}
