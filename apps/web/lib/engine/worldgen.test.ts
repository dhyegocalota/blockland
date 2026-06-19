import { describe, expect, it } from 'vitest';
import {
  AIR, BEDROCK_ID, GROUND, SIZE_Y, WATER_ID, WATER_LEVEL,
} from './constants';
import {
  Biome, baseVoxel, biomeAt, heightAt, surfaceBlock,
} from './worldgen';

const ALL_BIOMES: Biome[] = ['desert', 'plains', 'forest', 'snow'];
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

  it('produces every biome somewhere on the map', () => {
    const seen = new Set<Biome>();
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      seen.add(biomeAt(i * 53, i * 17));
      seen.add(biomeAt(-i * 31, i * 71));
    }
    for (const biome of ALL_BIOMES) expect(seen).toContain(biome);
  });
});

describe('surfaceBlock', () => {
  it('uses sand at and below the shoreline regardless of biome', () => {
    expect(surfaceBlock('plains', WATER_LEVEL + 1)).toBe(6);
    expect(surfaceBlock('forest', WATER_LEVEL)).toBe(6);
    expect(surfaceBlock('snow', WATER_LEVEL - 2)).toBe(6);
  });

  it('caps high peaks with snow', () => {
    expect(surfaceBlock('plains', GROUND + 9)).toBe(12);
    expect(surfaceBlock('desert', GROUND + 9)).toBe(12);
  });

  it('uses rock on mid-high mountains below the snow line', () => {
    expect(surfaceBlock('plains', GROUND + 7)).toBe(3);
    expect(surfaceBlock('forest', GROUND + 8)).toBe(3);
  });

  it('uses sand in the desert at normal elevation', () => {
    expect(surfaceBlock('desert', GROUND + 2)).toBe(6);
  });

  it('uses snow in the snow biome at normal elevation', () => {
    expect(surfaceBlock('snow', GROUND + 2)).toBe(12);
  });

  it('uses grass for plains and forest at normal elevation', () => {
    expect(surfaceBlock('plains', GROUND + 2)).toBe(1);
    expect(surfaceBlock('forest', GROUND + 2)).toBe(1);
  });

  it('prioritises the shoreline over the desert rule', () => {
    expect(surfaceBlock('desert', WATER_LEVEL + 1)).toBe(6);
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
    expect(baseVoxel(10, top, 10)).toBe(surfaceBlock(biomeAt(10, 10), top));
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

function findColumn(predicate: (top: number) => boolean): { x: number; z: number } {
  for (let i = 0; i < 5000; i++) {
    const x = i * 7;
    const z = i * 11;
    if (predicate(heightAt(x, z))) return { x, z };
  }
  throw new Error('no column satisfied the predicate');
}
