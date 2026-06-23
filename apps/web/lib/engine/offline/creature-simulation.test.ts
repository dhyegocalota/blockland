import { describe, expect, it, vi } from 'vitest';
import { createCreatureSimulation } from './creature-simulation';
import { CREATURE_DEFS } from './creatures';
import { Vec3 } from '../vec3';
import { EYE_HEIGHT, HEART_DROP_TTL_MS } from '../constants';
import { t } from '../../i18n';
import type { Creature, GameRuntime } from '../runtime';

function fakeMesh(): Creature['mesh'] {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { y: 0 } } as unknown as Creature['mesh'];
}

function makeRuntime() {
  const buildCreatureBody = vi.fn(() => ({ mesh: fakeMesh(), body: {} as Creature['body'] }));
  const syncCreatureMesh = vi.fn();
  const knockbackCreatureMesh = vi.fn();
  const disposeCreatureMesh = vi.fn();
  const onEvent = vi.fn();
  const heartDropRuntime = { spawn: vi.fn(), move: vi.fn(), update: vi.fn(), remove: vi.fn(), clear: vi.fn() };
  const runtime = {
    camera: { position: { x: 0, y: 0, z: 0 }, getWorldDirection: vi.fn() },
    creatures: [] as Creature[],
    heartDrops: [],
    heartDropRuntime,
    state: { peaceful: false, disposed: false, player: { pos: new Vec3(0, 2, 0), hearts: 3, hurtCooldown: 0, stars: 0, bag: 0 } },
    groundHeight: () => 0,
    buildCreatureBody,
    syncCreatureMesh,
    knockbackCreatureMesh,
    disposeCreatureMesh,
    hurtPlayer: vi.fn(),
    spawnPoof: vi.fn(),
    toast: vi.fn(),
    blip: vi.fn(),
    updateStats: vi.fn(),
    bridge: { resolveName: () => 'Maria', hud: { onEvent } },
  } as unknown as GameRuntime;
  createCreatureSimulation(runtime);
  return { runtime, buildCreatureBody, syncCreatureMesh, onEvent, heartDropRuntime };
}

function fakeCreature(typeKey: string): Creature {
  const def = CREATURE_DEFS[typeKey];
  return { typeKey, def, pos: new Vec3(0, 0, 0), mesh: fakeMesh(), body: {} as Creature['body'], hp: 0, dir: 0, timer: 0, bob: 0, flash: 0 };
}

describe('createCreatureSimulation', () => {
  it('spawnCreature builds the body only through the runtime view, never three.js', () => {
    const { runtime, buildCreatureBody } = makeRuntime();
    runtime.spawnCreature('pig');
    expect(buildCreatureBody).toHaveBeenCalledOnce();
    expect(runtime.creatures).toHaveLength(1);
    expect(runtime.creatures[0].typeKey).toBe('pig');
  });

  it('defeatCreature pushes a kill feed event naming the player and the creature', () => {
    const { runtime, onEvent } = makeRuntime();
    const creature = fakeCreature('spider');
    runtime.creatures.push(creature);
    runtime.defeatCreature(creature);
    expect(onEvent).toHaveBeenCalledWith({ kind: 'kill', name: 'Maria', detail: t('creature.spider') });
  });

  it('updateCreatures moves a creature through syncCreatureMesh, never touching three.js directly', () => {
    const { runtime, syncCreatureMesh } = makeRuntime();
    runtime.spawnCreature('pig');
    runtime.updateCreatures(0.016);
    expect(syncCreatureMesh).toHaveBeenCalledOnce();
    const [creature, transform] = syncCreatureMesh.mock.calls[0];
    expect(creature).toBe(runtime.creatures[0]);
    expect(transform).toEqual(expect.objectContaining({
      x: expect.any(Number), y: expect.any(Number), z: expect.any(Number),
      rotationY: expect.any(Number), flashing: expect.any(Boolean),
    }));
  });

  it('defeatCreature drops a heart at the creature and spawns its mesh', () => {
    const { runtime, heartDropRuntime } = makeRuntime();
    const creature = fakeCreature('spider');
    runtime.creatures.push(creature);
    runtime.defeatCreature(creature);
    expect(runtime.heartDrops).toHaveLength(1);
    expect(runtime.heartDrops[0].pos).toEqual(new Vec3(0, 0, 0));
    expect(heartDropRuntime.spawn).toHaveBeenCalledOnce();
  });

  it('updateCreatures separates two creatures that share a spot so they never stack', () => {
    const { runtime } = makeRuntime();
    runtime.state.peaceful = true;
    const a = fakeCreature('pig');
    const b = fakeCreature('pig');
    a.pos = new Vec3(20, 0, 20);
    b.pos = new Vec3(20, 0, 20);
    runtime.creatures.push(a, b);
    runtime.updateCreatures(0.016);
    const gap = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
    expect(gap).toBeGreaterThan(0.5);
  });

  it('updateHeartDrops heals a damaged player who walks over a drop and consumes it', () => {
    const { runtime, heartDropRuntime } = makeRuntime();
    runtime.state.player.hearts = 1;
    const creature = fakeCreature('spider');
    runtime.creatures.push(creature);
    runtime.defeatCreature(creature);
    const dropId = runtime.heartDrops[0].id;
    runtime.updateHeartDrops(performance.now());
    expect(runtime.state.player.hearts).toBe(2);
    expect(runtime.heartDrops).toHaveLength(0);
    expect(heartDropRuntime.remove).toHaveBeenCalledWith(dropId);
  });

  it('updateHeartDrops heals a player standing on a real kill drop floating at body height', () => {
    const { runtime } = makeRuntime();
    runtime.state.player.hearts = 1;
    const groundY = 12;
    (runtime as unknown as { groundHeight: () => number }).groundHeight = () => groundY;
    const creature = fakeCreature('spider');
    creature.pos = new Vec3(3, groundY + creature.def.size[1] / 2, 3);
    runtime.creatures.push(creature);
    runtime.defeatCreature(creature);
    runtime.state.player.pos.set(3, groundY + EYE_HEIGHT, 3);
    runtime.updateHeartDrops(performance.now());
    expect(runtime.state.player.hearts).toBe(2);
    expect(runtime.heartDrops).toHaveLength(0);
  });

  it('updateHeartDrops still picks up the heart for a full-hearted player without overhealing', () => {
    const { runtime } = makeRuntime();
    runtime.state.player.hearts = 3;
    const creature = fakeCreature('spider');
    runtime.creatures.push(creature);
    runtime.defeatCreature(creature);
    runtime.updateHeartDrops(performance.now());
    expect(runtime.state.player.hearts).toBe(3);
    expect(runtime.heartDrops).toHaveLength(0);
  });

  it('updateHeartDrops drops an out-of-radius heart only once its TTL expires', () => {
    const { runtime, heartDropRuntime } = makeRuntime();
    runtime.state.player.hearts = 1;
    const creature = fakeCreature('spider');
    creature.pos = new Vec3(50, 0, 50);
    runtime.creatures.push(creature);
    const spawnedAt = performance.now();
    runtime.defeatCreature(creature);
    runtime.heartDrops[0].spawnedAt = spawnedAt;
    runtime.updateHeartDrops(spawnedAt + 1000);
    expect(runtime.heartDrops).toHaveLength(1);
    runtime.updateHeartDrops(spawnedAt + HEART_DROP_TTL_MS + 1);
    expect(runtime.heartDrops).toHaveLength(0);
    expect(heartDropRuntime.remove).toHaveBeenCalledOnce();
  });
});
