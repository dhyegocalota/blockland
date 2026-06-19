import { describe, expect, it } from 'vitest';
import { FACE_ID } from './constants';
import {
  avaritiaTexture,
  BLOCKS,
  blockById,
  brickTexture,
  diamondTexture,
  goldTexture,
  paint,
  rainbowTexture,
  woodTexture,
  type BlockDef,
} from './blocks';

interface FillCall {
  color: string;
  rect: [number, number, number, number];
}

function fakeContext(): { ctx: CanvasRenderingContext2D; fills: FillCall[] } {
  const fills: FillCall[] = [];
  const recorder = {
    fillStyle: '#000000',
    globalAlpha: 1,
    fillRect(x: number, y: number, width: number, height: number): void {
      fills.push({ color: String(recorder.fillStyle), rect: [x, y, width, height] });
    },
  };
  return { ctx: recorder as unknown as CanvasRenderingContext2D, fills };
}

function definedBlocks(): BlockDef[] {
  return BLOCKS.filter((block): block is BlockDef => block !== null);
}

describe('BLOCKS registry', () => {
  it('reserves index 0 for air', () => {
    expect(BLOCKS[0]).toBeNull();
  });

  it('assigns ids that are unique', () => {
    const ids = definedBlocks().map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps ids contiguous from 1 with no gaps', () => {
    const ids = definedBlocks().map((block) => block.id);
    const expected = Array.from({ length: ids.length }, (_, index) => index + 1);
    expect(ids).toEqual(expected);
  });

  it('matches each id to its array index', () => {
    BLOCKS.forEach((block, index) => {
      if (!block) return;
      expect(block.id).toBe(index);
    });
  });

  it('gives every block a non-empty hotbar key', () => {
    for (const block of definedBlocks()) {
      expect(block.key.length).toBeGreaterThan(0);
    }
  });

  it('keeps hotbar keys unique', () => {
    const keys = definedBlocks().map((block) => block.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every non-face block an i18n name key under block.*', () => {
    for (const block of definedBlocks()) {
      if (block.id === FACE_ID) continue;
      expect(block.nameKey).toMatch(/^block\./);
    }
  });

  it('models the face block as builder-less with no name key (tenant injects the name)', () => {
    const face = blockById(FACE_ID);
    expect(face?.build).toBeNull();
    expect(face?.nameKey).toBeNull();
  });

  it('gives every non-face block a texture builder', () => {
    for (const block of definedBlocks()) {
      if (block.id === FACE_ID) continue;
      expect(block.build).toBeTypeOf('function');
    }
  });

  it('marks only water as transparent', () => {
    const transparentIds = definedBlocks()
      .filter((block) => block.transparent)
      .map((block) => block.id);
    expect(transparentIds).toEqual([11]);
  });

  it('pins the well-known hotbar keys', () => {
    expect(blockById(1)?.key).toBe('1');
    expect(blockById(FACE_ID)?.key).toBe('0');
  });
});

describe('blockById', () => {
  it('round-trips every defined block by id', () => {
    for (const block of definedBlocks()) {
      expect(blockById(block.id)).toBe(block);
    }
  });

  it('returns null for air', () => {
    expect(blockById(0)).toBeNull();
  });

  it('returns undefined past the registry bounds', () => {
    expect(blockById(BLOCKS.length)).toBeUndefined();
  });
});

describe('paint', () => {
  it('fills a base layer then 46 speckles', () => {
    const { ctx, fills } = fakeContext();
    paint('#111111', '#000000', '#ffffff')(ctx);
    expect(fills[0]).toEqual({ color: '#111111', rect: [0, 0, 16, 16] });
    expect(fills.length).toBe(1 + 46);
  });

  it('paints speckles only with the dark or light color', () => {
    const { ctx, fills } = fakeContext();
    paint('#111111', '#000000', '#ffffff')(ctx);
    const speckles = fills.slice(1);
    for (const speckle of speckles) {
      expect(['#000000', '#ffffff']).toContain(speckle.color);
      expect(speckle.rect[2]).toBe(1);
      expect(speckle.rect[3]).toBe(1);
    }
  });

  it('keeps every speckle inside the 16x16 tile', () => {
    const { ctx, fills } = fakeContext();
    paint('#111111', '#000000', '#ffffff')(ctx);
    for (const fill of fills.slice(1)) {
      const [x, y] = fill.rect;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(16);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(16);
    }
  });
});

describe('named texture painters', () => {
  it('woodTexture draws the base then grain stripes', () => {
    const { ctx, fills } = fakeContext();
    woodTexture(ctx);
    expect(fills[0].color).toBe('#9c6b3f');
    expect(fills.some((fill) => fill.color === '#7a4f2b')).toBe(true);
    expect(fills.some((fill) => fill.color === '#b3855a')).toBe(true);
  });

  it('brickTexture draws mortar lines over a red base', () => {
    const { ctx, fills } = fakeContext();
    brickTexture(ctx);
    expect(fills[0]).toEqual({ color: '#c0563f', rect: [0, 0, 16, 16] });
    expect(fills.some((fill) => fill.color === '#e8e0d0')).toBe(true);
  });

  it('goldTexture sparkles over a gold base', () => {
    const { ctx, fills } = fakeContext();
    goldTexture(ctx);
    expect(fills[0].color).toBe('#ffd23f');
    expect(fills.some((fill) => fill.color === '#caa018')).toBe(true);
  });

  it('rainbowTexture lays one stripe per spectrum color', () => {
    const { ctx, fills } = fakeContext();
    rainbowTexture(ctx);
    expect(fills.length).toBe(6);
    expect(fills.map((fill) => fill.color)).toEqual([
      '#ff5d5d',
      '#ffae3d',
      '#ffe93d',
      '#5dff7a',
      '#3dc6ff',
      '#9b6bff',
    ]);
  });

  it('diamondTexture draws bevels, gems and a center shine', () => {
    const { ctx, fills } = fakeContext();
    diamondTexture(ctx);
    expect(fills[0]).toEqual({ color: '#54cfd6', rect: [0, 0, 16, 16] });
    expect(fills.some((fill) => fill.color === '#ffffff')).toBe(true);
    expect(fills.some((fill) => fill.color === '#eafeff')).toBe(true);
  });

  it('avaritiaTexture restores globalAlpha after the nebula pass', () => {
    const { ctx, fills } = fakeContext();
    avaritiaTexture(ctx);
    expect(fills.length).toBeGreaterThan(0);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('runs every registered builder on a stub context without throwing', () => {
    for (const block of definedBlocks()) {
      if (!block.build) continue;
      const { ctx, fills } = fakeContext();
      expect(() => block.build!(ctx)).not.toThrow();
      expect(fills.length).toBeGreaterThan(0);
    }
  });
});
