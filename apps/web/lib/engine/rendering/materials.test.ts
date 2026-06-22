import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FACE_ID } from '../constants';
import { BLOCKS, blockById } from '../blocks';
import { buildMaterials, makeFaceMaterial } from './materials';

// A canvas whose 2d context swallows every drawing call, so the block/face builders can paint without
// a real DOM.
function stubCanvasFactory(): void {
  const context = new Proxy({}, { get: () => () => undefined });
  vi.spyOn(document, 'createElement').mockImplementation(() => ({
    width: 0,
    height: 0,
    getContext: () => context,
  }) as unknown as HTMLElement);
}

vi.stubGlobal('document', { createElement: vi.fn() });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildMaterials', () => {
  it('creates one material per defined block', () => {
    stubCanvasFactory();
    const materials: Record<number, THREE.MeshLambertMaterial> = {};
    buildMaterials({ materials, faceTexture: new THREE.Texture() });
    for (const b of BLOCKS) {
      if (!b) continue;
      expect(materials[b.id]).toBeInstanceOf(THREE.MeshLambertMaterial);
    }
  });

  it('uses the supplied face texture for the tenant face block', () => {
    stubCanvasFactory();
    const materials: Record<number, THREE.MeshLambertMaterial> = {};
    const faceTexture = new THREE.Texture();
    buildMaterials({ materials, faceTexture });
    expect(materials[FACE_ID].map).toBe(faceTexture);
  });

  it('marks transparent blocks double-sided with reduced opacity', () => {
    stubCanvasFactory();
    const materials: Record<number, THREE.MeshLambertMaterial> = {};
    buildMaterials({ materials, faceTexture: new THREE.Texture() });
    for (const b of BLOCKS) {
      if (!b) continue;
      const mat = materials[b.id];
      if (b.transparent) {
        expect(mat.transparent).toBe(true);
        expect(mat.opacity).toBe(0.78);
        expect(mat.side).toBe(THREE.DoubleSide);
      } else {
        expect(mat.transparent).toBe(false);
        expect(mat.opacity).toBe(1);
        expect(mat.side).toBe(THREE.FrontSide);
      }
    }
  });
});

describe('makeFaceMaterial', () => {
  it('returns a lambert material with a generated texture', () => {
    stubCanvasFactory();
    const mat = makeFaceMaterial('#abcdef');
    expect(mat).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(mat.map).toBeInstanceOf(THREE.Texture);
  });
});

describe('blockById', () => {
  it('still resolves a real block id (sanity for the material loop)', () => {
    expect(blockById(FACE_ID)?.id).toBe(FACE_ID);
  });
});
