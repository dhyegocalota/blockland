// Creature definitions as DATA only (kind, look, hp, speed, reward, emoji, name key), shared by the
// rendering glue: online snapshots name/colour them and coop-view builds the meshes from these defs.
// The wander/chase AI + hit-reward helpers that used to live here were deleted once the offline game
// moved to the Rust game-core via WASM — the core runs the AI now, so the TS copies were dead
// duplication. No three.js, no DOM: names resolve from `nameKey`.
//
// NB: the hp/speed/reward fields mirror the Rust creatures.rs `CreatureKind::config()`. These are the
// cleanest remaining dedup: they should be code-generated from Rust (like EYE_HEIGHT / DEATH_FALL_MS in
// constants.gen.ts) so they can never drift — a DEFERRED follow-up. The look fields (colour/size/emoji/
// nameKey) are client-only presentation and stay here.

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
  cow: { kind: 'animal', color: '#d8c5a8', size: [0.9, 0.9, 1.2], hp: 2, speed: 1.8, reward: 3, emoji: '🐮', nameKey: 'creature.cow' },
  slime: { kind: 'monster', color: '#5bd86a', size: [0.8, 0.8, 0.8], hp: 2, speed: 2.4, reward: 3, emoji: '👾', nameKey: 'creature.slime' },
  spider: { kind: 'monster', color: '#5a4a6a', size: [1.1, 0.6, 1.1], hp: 2, speed: 3.0, reward: 5, emoji: '🕷️', nameKey: 'creature.spider' },
};
