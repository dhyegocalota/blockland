import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAND_COLOR, faceBlockNameFor } from './tenant-brand';

describe('faceBlockNameFor', () => {
  it('appends a bang to the tenant name', () => {
    expect(faceBlockNameFor('Acme')).toBe('Acme!');
    expect(faceBlockNameFor('Blockland')).toBe('Blockland!');
  });

  it('handles an empty name', () => {
    expect(faceBlockNameFor('')).toBe('!');
  });
});

describe('DEFAULT_BRAND_COLOR', () => {
  it('is the shared Blockland gold', () => {
    expect(DEFAULT_BRAND_COLOR).toBe('#ffd23f');
  });
});
