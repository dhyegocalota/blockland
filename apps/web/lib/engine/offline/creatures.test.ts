import { describe, expect, it } from 'vitest';
import { type CreatureKind, CREATURE_DEFS, hitReward, stepCreatureDirection } from './creatures';

const base = { dist: 2, dir: 0.5, timer: 1, random: () => 0.5 };
const KINDS: CreatureKind[] = ['animal', 'monster'];

describe('CREATURE_DEFS', () => {
  it('lists every spawnable creature with an i18n name key', () => {
    expect(Object.keys(CREATURE_DEFS)).toEqual(['pig', 'chicken', 'cow', 'slime', 'spider']);
    for (const def of Object.values(CREATURE_DEFS)) expect(def.nameKey).toMatch(/^creature\./);
  });

  it('uses a name key that matches its registry id', () => {
    for (const [id, def] of Object.entries(CREATURE_DEFS)) expect(def.nameKey).toBe(`creature.${id}`);
  });

  it('has positive hp, speed and reward for every creature', () => {
    for (const def of Object.values(CREATURE_DEFS)) {
      expect(def.hp).toBeGreaterThan(0);
      expect(def.speed).toBeGreaterThan(0);
      expect(def.reward).toBeGreaterThan(0);
    }
  });

  it('declares a valid kind and a non-empty color and emoji', () => {
    for (const def of Object.values(CREATURE_DEFS)) {
      expect(KINDS).toContain(def.kind);
      expect(def.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(def.emoji.length).toBeGreaterThan(0);
    }
  });

  it('describes each creature with a positive 3-axis size', () => {
    for (const def of Object.values(CREATURE_DEFS)) {
      expect(def.size).toHaveLength(3);
      for (const axis of def.size) expect(axis).toBeGreaterThan(0);
    }
  });

  it('classifies pig/chicken/cow as animals and slime/spider as monsters', () => {
    expect(CREATURE_DEFS.pig.kind).toBe('animal');
    expect(CREATURE_DEFS.chicken.kind).toBe('animal');
    expect(CREATURE_DEFS.cow.kind).toBe('animal');
    expect(CREATURE_DEFS.slime.kind).toBe('monster');
    expect(CREATURE_DEFS.spider.kind).toBe('monster');
  });
});

describe('stepCreatureDirection', () => {
  it('homes a hostile monster toward the player', () => {
    const motion = stepCreatureDirection({ ...base, toPlayerX: 1, toPlayerZ: 0, dist: 5, isMonster: true, peaceful: false });
    expect(motion.dir).toBeCloseTo(Math.atan2(1, 0), 5);
    expect(motion.timer).toBe(base.timer);
  });

  it('homes toward a player on the negative axis too', () => {
    const motion = stepCreatureDirection({ ...base, toPlayerX: -3, toPlayerZ: -4, dist: 5, isMonster: true, peaceful: false });
    expect(motion.dir).toBeCloseTo(Math.atan2(-3, -4), 5);
  });

  it('chases only inside the aggro range and wanders beyond it', () => {
    const inside = stepCreatureDirection({ ...base, toPlayerX: 1, toPlayerZ: 0, dist: 29.9, isMonster: true, peaceful: false, timer: 1, dir: 0.5 });
    expect(inside.dir).toBeCloseTo(Math.atan2(1, 0), 5);
    const outside = stepCreatureDirection({ ...base, toPlayerX: 1, toPlayerZ: 0, dist: 30, isMonster: true, peaceful: false, timer: 1, dir: 0.5 });
    expect(outside.dir).toBe(0.5);
  });

  it('does not chase when peaceful', () => {
    const motion = stepCreatureDirection({ ...base, toPlayerX: 1, toPlayerZ: 0, dist: 5, isMonster: true, peaceful: true, timer: 1 });
    expect(motion.dir).toBe(0.5);
    expect(motion.timer).toBe(1);
  });

  it('makes an animal flee a nearby player', () => {
    const motion = stepCreatureDirection({ ...base, toPlayerX: 1, toPlayerZ: 0, dist: 2, isMonster: false, peaceful: true });
    expect(motion.dir).toBeCloseTo(Math.atan2(-1, 0), 5);
  });

  it('flees the player even when peaceful is false', () => {
    const motion = stepCreatureDirection({ ...base, toPlayerX: 2, toPlayerZ: 1, dist: 3, isMonster: false, peaceful: false });
    expect(motion.dir).toBeCloseTo(Math.atan2(-2, -1), 5);
  });

  it('lets an animal wander once the player is outside the flee range', () => {
    const motion = stepCreatureDirection({ ...base, toPlayerX: 1, toPlayerZ: 0, dist: 4, isMonster: false, peaceful: true, timer: 1, dir: 0.5 });
    expect(motion.dir).toBe(0.5);
  });

  it('picks a new wander direction and timer when the timer expires', () => {
    const motion = stepCreatureDirection({ ...base, toPlayerX: 0, toPlayerZ: 0, dist: 50, isMonster: false, peaceful: true, timer: 0, random: () => 0.5 });
    expect(motion.dir).toBeCloseTo(0.5 * Math.PI * 2, 5);
    expect(motion.timer).toBeCloseTo(1.5 + 0.5 * 2, 5);
  });

  it('draws the wander direction and timer from successive random calls', () => {
    const values = [0.25, 0.75];
    const random = () => values.shift() as number;
    const motion = stepCreatureDirection({ ...base, toPlayerX: 0, toPlayerZ: 0, dist: 50, isMonster: false, peaceful: true, timer: -1, random });
    expect(motion.dir).toBeCloseTo(0.25 * Math.PI * 2, 5);
    expect(motion.timer).toBeCloseTo(1.5 + 0.75 * 2, 5);
  });

  it('keeps the current direction while wandering with time left', () => {
    const motion = stepCreatureDirection({ ...base, toPlayerX: 0, toPlayerZ: 0, dist: 50, isMonster: false, peaceful: true, dir: 1.23, timer: 1 });
    expect(motion.dir).toBe(1.23);
    expect(motion.timer).toBe(1);
  });

  it('keeps wandering for an out-of-range hostile monster with time left', () => {
    const motion = stepCreatureDirection({ ...base, toPlayerX: 1, toPlayerZ: 0, dist: 30, isMonster: true, peaceful: false, dir: 2.5, timer: 1 });
    expect(motion.dir).toBe(2.5);
    expect(motion.timer).toBe(1);
  });
});

describe('hitReward', () => {
  it('returns the creature reward for each definition', () => {
    expect(hitReward(CREATURE_DEFS.pig)).toBe(2);
    expect(hitReward(CREATURE_DEFS.chicken)).toBe(1);
    expect(hitReward(CREATURE_DEFS.cow)).toBe(3);
    expect(hitReward(CREATURE_DEFS.slime)).toBe(3);
    expect(hitReward(CREATURE_DEFS.spider)).toBe(5);
  });
});
