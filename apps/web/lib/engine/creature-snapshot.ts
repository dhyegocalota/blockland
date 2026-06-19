// Pure helpers for rendering server-authoritative creatures from snapshots. In co-op the server owns
// every creature's motion, hp and death; the client only renders them. This module maps a wire
// `CreatureState` to the local creature definition (model/color/size) and resolves the i18n name key
// for the kill feed. No three.js, no DOM — fully unit-tested.

import { CREATURE_DEFS, type CreatureDef } from './creatures';

export function creatureDefFor(kind: string): CreatureDef {
  const def = CREATURE_DEFS[kind];
  if (!def) throw new Error(`unknown creature kind ${kind}`);
  return def;
}

export function creatureNameKey(kind: string): string {
  return creatureDefFor(kind).nameKey;
}
