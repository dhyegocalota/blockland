import { describe, expect, it } from 'vitest';
import { parseSavedPosition, serializeSavedPosition } from './saved-position';

describe('parseSavedPosition', () => {
  it('returns null for empty storage', () => {
    expect(parseSavedPosition(null)).toBeNull();
    expect(parseSavedPosition('')).toBeNull();
  });

  it('returns null for malformed json', () => {
    expect(parseSavedPosition('{not json')).toBeNull();
  });

  it('returns null when a coordinate is missing or not a number', () => {
    expect(parseSavedPosition('{"x":1,"y":2}')).toBeNull();
    expect(parseSavedPosition('{"x":1,"y":2,"z":"3"}')).toBeNull();
  });

  it('parses a valid vector', () => {
    expect(parseSavedPosition('{"x":1.5,"y":2,"z":-3}')).toEqual({ x: 1.5, y: 2, z: -3 });
  });
});

describe('serializeSavedPosition', () => {
  it('round-trips through parse', () => {
    const position = { x: 10, y: 20, z: 30 };
    expect(parseSavedPosition(serializeSavedPosition(position))).toEqual(position);
  });

  it('keeps only the three coordinates', () => {
    expect(serializeSavedPosition({ x: 1, y: 2, z: 3 })).toBe('{"x":1,"y":2,"z":3}');
  });
});
