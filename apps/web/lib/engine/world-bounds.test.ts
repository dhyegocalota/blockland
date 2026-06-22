import { describe, expect, it } from 'vitest';
import { MAX_FLY_Y, SIZE_Z } from './constants';
import { clampToWorld } from './world-bounds';

describe('clampToWorld', () => {
  it('pulls a position back inside the horizontal world', () => {
    const position = { x: -50, y: 20, z: SIZE_Z + 999 };
    clampToWorld(position);
    expect(position.x).toBe(0);
    expect(position.z).toBe(SIZE_Z);
  });

  it('caps the player at the flight ceiling but never lifts them', () => {
    const high = { x: 10, y: MAX_FLY_Y + 100, z: 10 };
    clampToWorld(high);
    expect(high.y).toBe(MAX_FLY_Y);

    const low = { x: 10, y: 5, z: 10 };
    clampToWorld(low);
    expect(low.y).toBe(5);
  });

  it('leaves an in-bounds position untouched', () => {
    const position = { x: 100, y: 30, z: 200 };
    clampToWorld(position);
    expect(position).toEqual({ x: 100, y: 30, z: 200 });
  });
});
