import { describe, expect, it } from 'vitest';
import { CHUNK } from './constants';
import {
  chunkDistanceSquared, chunkOutsideKeepRange, chunksInRadius, decodeChunkKey, playerChunk, remeshChunkRange,
} from './chunk-grid';

describe('playerChunk', () => {
  it('floors world coordinates into chunk coordinates', () => {
    expect(playerChunk({ x: CHUNK * 2 + 5, z: CHUNK * 3 - 1 })).toEqual({ cx: 2, cz: 2 });
  });
});

describe('decodeChunkKey', () => {
  it('splits a key back into coordinates', () => {
    const chunksZ = 10;
    expect(decodeChunkKey({ key: 2 * chunksZ + 3, chunksZ })).toEqual({ cx: 2, cz: 3 });
  });
});

describe('chunksInRadius', () => {
  it('returns the full square inside the world', () => {
    const coords = chunksInRadius({ center: { cx: 5, cz: 5 }, radius: 1, chunksX: 100, chunksZ: 100 });
    expect(coords).toHaveLength(9);
  });

  it('clips chunks outside the world bounds', () => {
    const coords = chunksInRadius({ center: { cx: 0, cz: 0 }, radius: 1, chunksX: 100, chunksZ: 100 });
    expect(coords).toHaveLength(4);
    expect(coords.every((c) => c.cx >= 0 && c.cz >= 0)).toBe(true);
  });
});

describe('chunkDistanceSquared', () => {
  it('measures squared distance from the center', () => {
    expect(chunkDistanceSquared({ chunk: { cx: 3, cz: 4 }, center: { cx: 0, cz: 0 } })).toBe(25);
  });
});

describe('remeshChunkRange', () => {
  it('covers the chunks spanning a world box, clamped to the grid', () => {
    const range = remeshChunkRange({ minX: -5, maxX: CHUNK + 1, minZ: 0, maxZ: CHUNK * 50, chunksX: 10, chunksZ: 10 });
    expect(range).toEqual({ cx0: 0, cx1: 1, cz0: 0, cz1: 9 });
  });
});

describe('chunkOutsideKeepRange', () => {
  it('keeps chunks within one ring past the radius', () => {
    expect(chunkOutsideKeepRange({ chunk: { cx: 7, cz: 0 }, center: { cx: 0, cz: 0 }, radius: 6 })).toBe(false);
  });

  it('evicts chunks two rings out', () => {
    expect(chunkOutsideKeepRange({ chunk: { cx: 8, cz: 0 }, center: { cx: 0, cz: 0 }, radius: 6 })).toBe(true);
  });
});
