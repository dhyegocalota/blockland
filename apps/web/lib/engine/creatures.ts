// Creature definitions as data plus pure AI helpers (wander/chase, hit reward).
// No three.js, no DOM: names are resolved by the glue from `nameKey`.

export type CreatureKind = 'animal' | 'monster';

export interface CreatureDef {
  kind: CreatureKind;
  color: string;
  size: [number, number, number];
  hp: number;
  speed: number;
  reward: number;
  emoji: string;
  nameKey: string;
}

export const CREATURE_DEFS: Record<string, CreatureDef> = {
  pig: { kind: 'animal', color: '#ff9bbf', size: [0.8, 0.7, 1.0], hp: 2, speed: 2.2, reward: 2, emoji: '🐷', nameKey: 'creature.pig' },
  chicken: { kind: 'animal', color: '#fffbe0', size: [0.6, 0.7, 0.6], hp: 1, speed: 2.6, reward: 1, emoji: '🐔', nameKey: 'creature.chicken' },
  cow: { kind: 'animal', color: '#d8c5a8', size: [0.9, 0.9, 1.2], hp: 3, speed: 1.8, reward: 3, emoji: '🐮', nameKey: 'creature.cow' },
  slime: { kind: 'monster', color: '#5bd86a', size: [0.8, 0.8, 0.8], hp: 2, speed: 2.4, reward: 3, emoji: '👾', nameKey: 'creature.slime' },
  spider: { kind: 'monster', color: '#5a4a6a', size: [1.1, 0.6, 1.1], hp: 3, speed: 3.0, reward: 5, emoji: '🕷️', nameKey: 'creature.spider' },
};

export interface CreatureMotion {
  dir: number;
  timer: number;
}

// Hostile monsters home in on a player within this horizontal distance. Mirrors the Rust CHASE_RADIUS
// and must cover the spawn spread, else monsters wander forever just out of reach and never bite.
const CHASE_RADIUS = 30;
// Animals flee a player who gets this close.
const FLEE_RADIUS = 4;

// Decides facing + wander timer for one creature tick, matching the original AI:
// hostile monsters home in, animals flee, otherwise random wander on timer expiry.
export function stepCreatureDirection({
  toPlayerX, toPlayerZ, dist, isMonster, peaceful, dir, timer, random,
}: {
  toPlayerX: number;
  toPlayerZ: number;
  dist: number;
  isMonster: boolean;
  peaceful: boolean;
  dir: number;
  timer: number;
  random: () => number;
}): CreatureMotion {
  const hostile = isMonster && !peaceful;
  if (hostile && dist < CHASE_RADIUS) return { dir: Math.atan2(toPlayerX, toPlayerZ), timer };
  if (!isMonster && dist < FLEE_RADIUS) return { dir: Math.atan2(-toPlayerX, -toPlayerZ), timer };
  if (timer <= 0) return { dir: random() * Math.PI * 2, timer: 1.5 + random() * 2 };
  return { dir, timer };
}

export function hitReward(def: CreatureDef): number {
  return def.reward;
}
