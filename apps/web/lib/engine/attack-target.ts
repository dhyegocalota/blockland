// Pure target priority for a left-click: with the crosshair hitting a block, a creature and (in pvp) a
// remote player at various distances, decide what the click acts on. The raycasts and the actual
// hit/break stay in the glue; this resolves which one wins, unit-tested. `t` is the hit distance; the
// block's distance is Infinity when nothing is aimed at.

export type AttackTarget = 'player' | 'creature' | 'block' | 'none';

// Single-player: the creature wins if it is no farther than the aimed block, otherwise break the block.
export function chooseLocalTarget({
  creatureT, blockDistance, hasBlock,
}: {
  creatureT: number | null;
  blockDistance: number;
  hasBlock: boolean;
}): AttackTarget {
  if (creatureT !== null && creatureT <= blockDistance) return 'creature';
  if (hasBlock) return 'block';
  return 'none';
}

// Co-op: a remote player beats a creature at equal range, both beat the block; otherwise break it.
export function chooseCoopTarget({
  playerT, creatureT, blockDistance, hasBlock,
}: {
  playerT: number | null;
  creatureT: number | null;
  blockDistance: number;
  hasBlock: boolean;
}): AttackTarget {
  if (playerT !== null && playerT <= blockDistance && (creatureT === null || playerT <= creatureT)) return 'player';
  if (creatureT !== null && creatureT <= blockDistance) return 'creature';
  if (hasBlock) return 'block';
  return 'none';
}
