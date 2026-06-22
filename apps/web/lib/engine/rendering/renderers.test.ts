import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createViewRenderer } from './renderers';
import type { VoxelHit } from '../raycast';

function makeRenderer() {
  const camera = new THREE.PerspectiveCamera();
  const highlight = new THREE.Object3D();
  let presentCount = 0;
  const fakeRenderer = { render: () => { presentCount++; } } as unknown as THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  const view = createViewRenderer({ camera, highlight, renderer: fakeRenderer, scene });
  return { camera, highlight, view, present: () => presentCount };
}

describe('createViewRenderer', () => {
  it('places the camera at the player eye position', () => {
    const { camera, view } = makeRenderer();
    view.renderView({ pose: { x: 5, y: 6, z: 7, yaw: 0, pitch: 0 }, aim: null });
    expect(camera.position.x).toBe(5);
    expect(camera.position.y).toBe(6);
    expect(camera.position.z).toBe(7);
  });

  it('hides the highlight when nothing is aimed', () => {
    const { highlight, view } = makeRenderer();
    highlight.visible = true;
    view.renderView({ pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: null });
    expect(highlight.visible).toBe(false);
  });

  it('shows the highlight centered on the aimed cell', () => {
    const { highlight, view } = makeRenderer();
    const aim: VoxelHit = { hit: [3, 4, 5], place: [3, 5, 5] };
    view.renderView({ pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim });
    expect(highlight.visible).toBe(true);
    expect(highlight.position.x).toBe(3.5);
    expect(highlight.position.y).toBe(4.5);
    expect(highlight.position.z).toBe(5.5);
  });

  it('presents through the renderer', () => {
    const { view, present } = makeRenderer();
    view.present();
    view.present();
    expect(present()).toBe(2);
  });
});
