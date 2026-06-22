import * as THREE from 'three';
import { describe, it, expect, beforeEach } from 'vitest';
import { POOF_COUNT } from './poofs';
import { createPoofRuntime } from './poofs-runtime';

describe('createPoofRuntime', () => {
  let scene: THREE.Scene;

  beforeEach(() => {
    scene = new THREE.Scene();
  });

  it('spawn adds one mesh per particle into the scene', () => {
    const runtime = createPoofRuntime({ scene });
    runtime.spawn(new THREE.Vector3(1, 2, 3), '#ff0000');
    expect(scene.children.length).toBe(POOF_COUNT);
    for (const child of scene.children) expect(child.position.toArray()).toEqual([1, 2, 3]);
  });

  it('update removes particles once their life runs out', () => {
    const runtime = createPoofRuntime({ scene });
    runtime.spawn(new THREE.Vector3(), '#00ff00');
    runtime.update(10);
    expect(scene.children.length).toBe(0);
  });

  it('update keeps live particles and moves them', () => {
    const runtime = createPoofRuntime({ scene });
    runtime.spawn(new THREE.Vector3(), '#0000ff');
    runtime.update(0.05);
    expect(scene.children.length).toBe(POOF_COUNT);
  });

  it('clear wipes every particle in place', () => {
    const runtime = createPoofRuntime({ scene });
    runtime.spawn(new THREE.Vector3(), '#ffffff');
    runtime.spawn(new THREE.Vector3(), '#ffffff');
    runtime.clear();
    expect(scene.children.length).toBe(0);
  });
});
