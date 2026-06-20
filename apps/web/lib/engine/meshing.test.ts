import { describe, expect, it } from 'vitest';
import { AIR } from './constants';
import { type MeshBucket, meshChunkBuckets } from './meshing';

const SOLID = 3;
const GLASS = 11;

// A 4x4 voxel column accessor backed by a plain map, so each test sees only the blocks it places.
function makeWorld(cells: Record<string, number>): (x: number, y: number, z: number) => number {
  return (x, y, z) => cells[`${x},${y},${z}`] ?? AIR;
}

const opaqueOnly = (id: number): boolean => id === GLASS;
const bounds = { x0: 0, x1: 4, z0: 0, z1: 4, sizeY: 4 };

const QUAD_VERTS = 4;
const QUAD_INDICES = 6;
const CUBE_FACES = 6;

function faceCount(bucket: MeshBucket): number {
  return bucket.pos.length / 3 / QUAD_VERTS;
}

describe('meshChunkBuckets', () => {
  it('returns no buckets for an empty chunk', () => {
    const buckets = meshChunkBuckets({ getVoxel: makeWorld({}), isTransparent: opaqueOnly, ...bounds });
    expect(buckets.size).toBe(0);
  });

  it('emits all six faces for a single isolated block', () => {
    const buckets = meshChunkBuckets({ getVoxel: makeWorld({ '1,1,1': SOLID }), isTransparent: opaqueOnly, ...bounds });
    const bucket = buckets.get(SOLID);
    expect(bucket).toBeDefined();
    expect(faceCount(bucket!)).toBe(CUBE_FACES);
    expect(bucket!.uv.length).toBe(CUBE_FACES * QUAD_VERTS * 2);
    expect(bucket!.idxs.length).toBe(CUBE_FACES * QUAD_INDICES);
  });

  it('culls the shared face between two adjacent opaque blocks', () => {
    const buckets = meshChunkBuckets({ getVoxel: makeWorld({ '1,1,1': SOLID, '2,1,1': SOLID }), isTransparent: opaqueOnly, ...bounds });
    expect(faceCount(buckets.get(SOLID)!)).toBe(CUBE_FACES * 2 - 2);
  });

  it('groups faces by block id', () => {
    const buckets = meshChunkBuckets({ getVoxel: makeWorld({ '1,1,1': SOLID, '3,1,1': GLASS }), isTransparent: opaqueOnly, ...bounds });
    expect(buckets.get(SOLID)).toBeDefined();
    expect(buckets.get(GLASS)).toBeDefined();
    expect(buckets.size).toBe(2);
  });

  it('keeps the opaque face touching a transparent neighbor', () => {
    const buckets = meshChunkBuckets({ getVoxel: makeWorld({ '1,1,1': SOLID, '2,1,1': GLASS }), isTransparent: opaqueOnly, ...bounds });
    expect(faceCount(buckets.get(SOLID)!)).toBe(CUBE_FACES);
  });

  it('hides a transparent face that touches any non-air neighbor', () => {
    const buckets = meshChunkBuckets({ getVoxel: makeWorld({ '1,1,1': GLASS, '2,1,1': SOLID }), isTransparent: opaqueOnly, ...bounds });
    expect(faceCount(buckets.get(GLASS)!)).toBe(CUBE_FACES - 1);
  });

  it('reads neighbors outside the chunk bounds for correct edge culling', () => {
    const world = makeWorld({ '0,1,1': SOLID, '-1,1,1': SOLID });
    const buckets = meshChunkBuckets({ getVoxel: world, isTransparent: opaqueOnly, ...bounds });
    expect(faceCount(buckets.get(SOLID)!)).toBe(CUBE_FACES - 1);
  });

  it('places the first vertex of each quad at the block corner', () => {
    const buckets = meshChunkBuckets({ getVoxel: makeWorld({ '1,1,1': SOLID }), isTransparent: opaqueOnly, ...bounds });
    const bucket = buckets.get(SOLID)!;
    expect(bucket.pos.slice(0, 3)).toEqual([2, 1, 1]);
    expect(bucket.idxs.slice(0, 6)).toEqual([0, 1, 2, 0, 2, 3]);
  });
});
