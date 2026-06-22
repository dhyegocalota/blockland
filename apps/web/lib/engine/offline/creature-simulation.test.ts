import { describe, expect, it, vi } from 'vitest';
import { createCreatureSimulation } from './creature-simulation';
import type { Creature, GameRuntime } from '../runtime';

function fakeMesh(): Creature['mesh'] {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { y: 0 } } as unknown as Creature['mesh'];
}

function makeRuntime() {
  const buildCreatureBody = vi.fn(() => ({ mesh: fakeMesh(), body: {} as Creature['body'] }));
  const syncCreatureMesh = vi.fn();
  const knockbackCreatureMesh = vi.fn();
  const disposeCreatureMesh = vi.fn();
  const runtime = {
    camera: { position: { x: 0, y: 0, z: 0 }, getWorldDirection: vi.fn() },
    creatures: [] as Creature[],
    state: { peaceful: false, player: { pos: { x: 0, y: 2, z: 0 }, hurtCooldown: 0 } },
    groundHeight: () => 0,
    buildCreatureBody,
    syncCreatureMesh,
    knockbackCreatureMesh,
    disposeCreatureMesh,
    hurtPlayer: vi.fn(),
  } as unknown as GameRuntime;
  createCreatureSimulation(runtime);
  return { runtime, buildCreatureBody, syncCreatureMesh };
}

describe('createCreatureSimulation', () => {
  it('spawnCreature builds the body only through the runtime view, never three.js', () => {
    const { runtime, buildCreatureBody } = makeRuntime();
    runtime.spawnCreature('pig');
    expect(buildCreatureBody).toHaveBeenCalledOnce();
    expect(runtime.creatures).toHaveLength(1);
    expect(runtime.creatures[0].typeKey).toBe('pig');
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
