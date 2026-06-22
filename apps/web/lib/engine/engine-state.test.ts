import { describe, expect, it } from 'vitest';
import { Vec3 } from './vec3';
import { MAX_HEARTS } from './constants';
import { createEngineState } from './engine-state';

describe('createEngineState', () => {
  it('starts the player at the given spawn with full hearts and empty scores', () => {
    const spawn = new Vec3(1, 2, 3);
    const { player } = createEngineState({ spawn });
    expect(player.pos.equals(spawn)).toBe(true);
    expect(player.vel.equals(new Vec3())).toBe(true);
    expect(player.yaw).toBe(Math.PI);
    expect(player.pitch).toBe(-0.2);
    expect(player.onGround).toBe(false);
    expect(player.fly).toBe(false);
    expect(player.hearts).toBe(MAX_HEARTS);
    expect(player.stars).toBe(0);
    expect(player.bag).toBe(0);
    expect(player.hurtCooldown).toBe(0);
  });

  it('does not alias the spawn vector into the player position', () => {
    const spawn = new Vec3(1, 2, 3);
    const { player } = createEngineState({ spawn });
    player.pos.x = 99;
    expect(spawn.x).toBe(1);
  });

  it('seeds the room flags to the offline defaults (peaceful, infinite, no gates)', () => {
    const state = createEngineState({ spawn: new Vec3() });
    expect(state.selected).toBe(1);
    expect(state.peaceful).toBe(true);
    expect(state.pvp).toBe(false);
    expect(state.chatEnabled).toBe(true);
    expect(state.approvalRequired).toBe(false);
    expect(state.infiniteResources).toBe(true);
  });

  it('starts not attacking with a zeroed repeat timer', () => {
    const state = createEngineState({ spawn: new Vec3() });
    expect(state.attacking).toBe(false);
    expect(state.attackSince).toBe(0);
  });

  it('seeds the runtime/loop flags', () => {
    const state = createEngineState({ spawn: new Vec3() });
    expect(state.fps).toBe(0);
    expect(state.paused).toBe(false);
    expect(state.started).toBe(false);
    expect(state.disposed).toBe(false);
    expect(state.rafId).toBe(0);
  });

  it('starts with an empty keys map and an idle joystick', () => {
    const { keys, joystick } = createEngineState({ spawn: new Vec3() });
    expect(keys).toEqual({});
    expect(joystick).toEqual({ active: false, x: 0, y: 0, id: null, cx: 0, cy: 0, r: 50 });
  });
});
