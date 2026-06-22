import { describe, expect, it } from 'vitest';
import { updateRequired } from './use-update-check';

describe('updateRequired', () => {
  it('forces an update when two real builds differ', () => {
    expect(updateRequired({ loaded: 'abc123', deployed: 'def456' })).toBe(true);
  });

  it('does not force an update when the builds match', () => {
    expect(updateRequired({ loaded: 'abc123', deployed: 'abc123' })).toBe(false);
  });

  it('never traps the local dev build (loaded is dev)', () => {
    expect(updateRequired({ loaded: 'dev', deployed: 'abc123' })).toBe(false);
  });

  it('never forces an update against a dev deployment', () => {
    expect(updateRequired({ loaded: 'abc123', deployed: 'dev' })).toBe(false);
  });
});
