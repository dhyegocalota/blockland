import { describe, expect, it } from 'vitest';
import { canMonsterReachPlayer, HURT_RANGE } from './hurt';

const near = { x: 0.5, y: 1, z: 0.5 };
const player = { playerX: 0, playerFeetY: 1, playerZ: 0, playerHeight: 1.8 };

describe('canMonsterReachPlayer', () => {
  it('hits a close, level, unburied monster', () => {
    expect(canMonsterReachPlayer({ monster: near, ...player, buried: false })).toBe(true);
  });

  it('misses a monster out of range', () => {
    expect(canMonsterReachPlayer({ monster: { x: HURT_RANGE + 1, y: 1, z: 0 }, ...player, buried: false })).toBe(false);
  });

  it('misses a monster lurking below the floor', () => {
    expect(canMonsterReachPlayer({ monster: { x: 0.5, y: -2, z: 0.5 }, ...player, buried: false })).toBe(false);
  });

  it('misses a monster above the player head', () => {
    expect(canMonsterReachPlayer({ monster: { x: 0.5, y: 10, z: 0.5 }, ...player, buried: false })).toBe(false);
  });

  it('misses a monster buried inside a block, even when close', () => {
    expect(canMonsterReachPlayer({ monster: near, ...player, buried: true })).toBe(false);
  });
});
