import { describe, expect, it } from 'vitest';
import {
  AIR, BEDROCK_ID, DIRT_ID, FACE_ID, GOLD_ID, GRASS_ID, GROUND, SAND_ID, SIZE_X, SIZE_Y, SIZE_Z,
  STONE_ID, WATER_ID, WATER_LEVEL, WHITE_ID,
} from './constants';
import {
  Biome, baseVoxel, biomeAt, heightAt, surfaceBlock, welcomeMonumentBlock,
} from './worldgen';

const ALL_BIOMES: Biome[] = [
  'ocean', 'beach', 'plains', 'forest', 'desert', 'savanna', 'mountains', 'snow',
];
const SAMPLE_COUNT = 1000;

describe('heightAt', () => {
  it('is deterministic for a coordinate', () => {
    expect(heightAt(100, 200)).toBe(heightAt(100, 200));
    expect(heightAt(-37, 941)).toBe(heightAt(-37, 941));
  });

  it('returns an integer height', () => {
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const height = heightAt(i * 37, i * 91);
      expect(Number.isInteger(height)).toBe(true);
    }
  });

  it('stays within the playable band', () => {
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const height = heightAt(i * 37 - 500, i * 91 - 500);
      expect(height).toBeGreaterThanOrEqual(2);
      expect(height).toBeLessThanOrEqual(SIZE_Y - 5);
    }
  });

  it('varies across the map', () => {
    const heights = new Set<number>();
    for (let i = 0; i < SAMPLE_COUNT; i++) heights.add(heightAt(i * 13, i * 29));
    expect(heights.size).toBeGreaterThan(1);
  });
});

describe('biomeAt', () => {
  it('is deterministic for a coordinate', () => {
    expect(biomeAt(100, 200)).toBe(biomeAt(100, 200));
  });

  it('only ever returns a known biome', () => {
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      expect(ALL_BIOMES).toContain(biomeAt(i * 53, i * 17));
    }
  });

  it('produces several biomes across a broad sweep of the map', () => {
    const seen = new Set<Biome>();
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      seen.add(biomeAt(i * 271 - 60000, i * 409 - 60000));
      seen.add(biomeAt(-i * 313, i * 719));
    }
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe('surfaceBlock', () => {
  it('maps each biome to a fitting block', () => {
    expect(surfaceBlock('ocean')).toBe(SAND_ID);
    expect(surfaceBlock('beach')).toBe(SAND_ID);
    expect(surfaceBlock('desert')).toBe(SAND_ID);
    expect(surfaceBlock('snow')).toBe(WHITE_ID);
    expect(surfaceBlock('mountains')).toBe(STONE_ID);
    expect(surfaceBlock('savanna')).toBe(DIRT_ID);
    expect(surfaceBlock('plains')).toBe(GRASS_ID);
    expect(surfaceBlock('forest')).toBe(GRASS_ID);
  });
});

describe('baseVoxel', () => {
  it('is deterministic for a coordinate', () => {
    expect(baseVoxel(40, 3, 80)).toBe(baseVoxel(40, 3, 80));
  });

  it('places bedrock at the bottom', () => {
    expect(baseVoxel(10, 0, 10)).toBe(BEDROCK_ID);
    expect(baseVoxel(-200, 0, 350)).toBe(BEDROCK_ID);
  });

  it('places the surface block exactly at the top', () => {
    const top = heightAt(10, 10);
    expect(baseVoxel(10, top, 10)).toBe(surfaceBlock(biomeAt(10, 10)));
  });

  it('fills the two cells under the surface with dirt', () => {
    const top = heightAt(10, 10);
    expect(baseVoxel(10, top - 1, 10)).toBe(2);
    expect(baseVoxel(10, top - 2, 10)).toBe(2);
  });

  it('fills the deep interior with stone', () => {
    const top = heightAt(10, 10);
    expect(baseVoxel(10, top - 3, 10)).toBe(3);
    expect(baseVoxel(10, 1, 10)).toBe(3);
  });

  it('puts air above the surface on a dry column', () => {
    const dry = findColumn((top) => top > WATER_LEVEL);
    const top = heightAt(dry.x, dry.z);
    expect(baseVoxel(dry.x, top + 1, dry.z)).toBe(AIR);
    expect(baseVoxel(dry.x, SIZE_Y - 1, dry.z)).toBe(AIR);
  });

  it('fills with water above a submerged surface up to the water level', () => {
    const wet = findColumn((top) => top < WATER_LEVEL);
    const top = heightAt(wet.x, wet.z);
    expect(baseVoxel(wet.x, top + 1, wet.z)).toBe(WATER_ID);
    expect(baseVoxel(wet.x, WATER_LEVEL, wet.z)).toBe(WATER_ID);
    expect(baseVoxel(wet.x, WATER_LEVEL + 1, wet.z)).toBe(AIR);
  });

  it('never returns water at or below the surface', () => {
    const wet = findColumn((top) => top < WATER_LEVEL);
    const top = heightAt(wet.x, wet.z);
    for (let y = 0; y <= top; y++) {
      expect(baseVoxel(wet.x, y, wet.z)).not.toBe(WATER_ID);
    }
  });

  it('keeps a solid bedrock floor beneath every column', () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 47 - 1000;
      const z = i * 83 - 1000;
      expect(baseVoxel(x, 0, z)).toBe(BEDROCK_ID);
    }
  });
});

describe('welcome monument folded into worldgen', () => {
  const cx = SIZE_X >> 1;
  const cz = SIZE_Z >> 1;
  const top = heightAt(cx, cz);

  it('stacks a two-cell face column above the centre top', () => {
    expect(welcomeMonumentBlock(cx, top + 1, cz)).toBe(FACE_ID);
    expect(welcomeMonumentBlock(cx, top + 2, cz)).toBe(FACE_ID);
  });

  it('rings the face with a four-cell gold cross at the base', () => {
    expect(welcomeMonumentBlock(cx - 1, top + 1, cz)).toBe(GOLD_ID);
    expect(welcomeMonumentBlock(cx + 1, top + 1, cz)).toBe(GOLD_ID);
    expect(welcomeMonumentBlock(cx, top + 1, cz - 1)).toBe(GOLD_ID);
    expect(welcomeMonumentBlock(cx, top + 1, cz + 1)).toBe(GOLD_ID);
  });

  it('is air just outside the monument cells', () => {
    expect(welcomeMonumentBlock(cx, top, cz)).toBe(AIR);
    expect(welcomeMonumentBlock(cx, top + 3, cz)).toBe(AIR);
    expect(welcomeMonumentBlock(cx - 1, top + 2, cz)).toBe(AIR);
    expect(welcomeMonumentBlock(cx + 2, top + 1, cz)).toBe(AIR);
  });

  it('leaves columns far from the centre untouched', () => {
    expect(welcomeMonumentBlock(10, top + 1, 10)).toBe(AIR);
    expect(welcomeMonumentBlock(cx, top + 1, cz + 5)).toBe(AIR);
  });

  it('surfaces the monument through baseVoxel above the centre terrain', () => {
    expect(baseVoxel(cx, top + 1, cz)).toBe(FACE_ID);
    expect(baseVoxel(cx, top + 2, cz)).toBe(FACE_ID);
    expect(baseVoxel(cx - 1, top + 1, cz)).toBe(GOLD_ID);
    expect(baseVoxel(cx, top + 3, cz)).toBe(AIR);
    const farTop = heightAt(10, 10);
    expect(baseVoxel(10, farTop + 1, 10)).not.toBe(FACE_ID);
    expect(baseVoxel(10, farTop + 1, 10)).not.toBe(GOLD_ID);
  });
});

function findColumn(predicate: (top: number) => boolean): { x: number; z: number } {
  for (let i = 0; i < 5000; i++) {
    const x = i * 7;
    const z = i * 11;
    if (predicate(heightAt(x, z))) return { x, z };
  }
  throw new Error('no column satisfied the predicate');
}
