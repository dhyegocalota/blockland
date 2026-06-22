import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { creatureDefFor } from '../online/creature-snapshot';
import { createCoopView } from './coop-view';

// A canvas whose 2d context swallows every drawing call, so the avatar/label/bubble/creature builders
// can paint without a real DOM (the vitest env is node, mirroring materials.test.ts).
function stubCanvasFactory(): void {
  const context = new Proxy({}, { get: () => () => undefined });
  vi.spyOn(document, 'createElement').mockImplementation(() => ({
    width: 0,
    height: 0,
    getContext: () => context,
  }) as unknown as HTMLElement);
}

vi.stubGlobal('document', { createElement: vi.fn() });
vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined });

const LOOK = { skin: '#f0c', shirt: '#0cf', hair: '#321' };

describe('createCoopView', () => {
  let scene: THREE.Scene;

  beforeEach(() => {
    scene = new THREE.Scene();
    stubCanvasFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds one group per player on join and removes it on leave', () => {
    const view = createCoopView({ scene });
    view.onPlayerJoin(1, 'Maria', LOOK);
    expect(scene.children.length).toBe(1);
    expect(scene.children[0]).toBeInstanceOf(THREE.Group);
    view.onPlayerLeave(1);
    expect(scene.children.length).toBe(0);
  });

  it('moves and rotates the avatar group on pose', () => {
    const view = createCoopView({ scene });
    view.onPlayerJoin(1, 'Maria', LOOK);
    view.onPlayerPose(1, 4, 5, 6, 1.2);
    const group = scene.children[0];
    expect(group.position.toArray()).toEqual([4, 5, 6]);
    expect(group.rotation.y).toBe(1.2);
  });

  it('renames only the live avatar without changing the scene count', () => {
    const view = createCoopView({ scene });
    view.onPlayerJoin(1, 'Maria', LOOK);
    view.onPlayerRename(1, 'Joao');
    expect(scene.children.length).toBe(1);
  });

  it('spawns, poses and despawns a server creature', () => {
    const view = createCoopView({ scene });
    view.onCreatureSpawn(7, creatureDefFor('slime'));
    expect(scene.children.length).toBe(1);
    view.onCreaturePose(7, 1, 2, 3, 0.5);
    expect(scene.children[0].position.toArray()).toEqual([1, 2, 3]);
    view.onCreatureDespawn(7);
    expect(scene.children.length).toBe(0);
  });

  it('ignores pose/chat/flash for unknown ids', () => {
    const view = createCoopView({ scene });
    expect(() => view.onPlayerPose(99, 0, 0, 0, 0)).not.toThrow();
    expect(() => view.onPlayerChat(99, 'hi')).not.toThrow();
    expect(() => view.onCreatureFlash(99)).not.toThrow();
    expect(scene.children.length).toBe(0);
  });
});
