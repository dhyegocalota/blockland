import { describe, expect, it, vi } from 'vitest';
import { createCreatureSimulation } from './creature-simulation';
import { CREATURE_DEFS } from './creatures';
import { Vec3 } from '../vec3';
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
  const runtime = {
    camera: { position: { x: 0, y: 0, z: 0 }, getWorldDirection: vi.fn() },
    creatures: [] as Creature[],
    state: { peaceful: false, disposed: false, player: { pos: { x: 0, y: 2, z: 0 }, hurtCooldown: 0, stars: 0, bag: 0 } },
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
  return { runtime, buildCreatureBody, syncCreatureMesh, onEvent };
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
});
