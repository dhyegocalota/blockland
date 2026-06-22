import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockDef } from '../blocks';
import { ctx2d, makeCanvas, renderBlockCanvas, textureFromCanvas } from './textures';

interface FakeCanvas {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
}

function stubCanvas(context: unknown): FakeCanvas {
  const canvas: FakeCanvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
  vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement);
  return canvas;
}

vi.stubGlobal('document', { createElement: vi.fn() });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('makeCanvas', () => {
  it('creates a 16x16 canvas', () => {
    stubCanvas({});
    const canvas = makeCanvas();
    expect(canvas.width).toBe(16);
    expect(canvas.height).toBe(16);
  });
});

describe('ctx2d', () => {
  it('throws when no 2d context is available', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => ctx2d(canvas)).toThrow('2d canvas context unavailable');
  });

  it('returns the 2d context', () => {
    const context = {};
    const canvas = { getContext: () => context } as unknown as HTMLCanvasElement;
    expect(ctx2d(canvas)).toBe(context);
  });
});

describe('renderBlockCanvas', () => {
  it('paints via the block builder on a fresh canvas', () => {
    const context = {};
    stubCanvas(context);
    const build = vi.fn();
    const block = { id: 7, build } as unknown as BlockDef;
    renderBlockCanvas(block);
    expect(build).toHaveBeenCalledWith(context);
  });

  it('throws when the block has no builder', () => {
    stubCanvas({});
    const block = { id: 9 } as unknown as BlockDef;
    expect(() => renderBlockCanvas(block)).toThrow('block 9 has no texture builder');
  });
});

describe('textureFromCanvas', () => {
  it('wraps the canvas with nearest pixel filtering', () => {
    const canvas = {} as unknown as HTMLCanvasElement;
    const texture = textureFromCanvas(canvas);
    expect(texture.magFilter).toBe(THREE.NearestFilter);
    expect(texture.minFilter).toBe(THREE.NearestFilter);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
  });
});
