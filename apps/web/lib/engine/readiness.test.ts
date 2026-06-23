import { describe, expect, it } from 'vitest';
import { connectStatusKey, isInteractive, type ReadinessInput } from './readiness';

const base: ReadinessInput = {
  offline: false,
  started: false,
  netState: null,
  welcomed: false,
  firstSnapshot: false,
};

describe('isInteractive', () => {
  it('is never interactive before Play is pressed', () => {
    expect(isInteractive({ ...base, started: false, offline: true })).toBe(false);
  });

  it('is interactive offline the moment the engine starts', () => {
    expect(isInteractive({ ...base, started: true, offline: true })).toBe(true);
  });

  it('is not interactive online while the socket is still connecting', () => {
    expect(isInteractive({ ...base, started: true, netState: 'connecting' })).toBe(false);
  });

  it('is not interactive online once open but before the Welcome', () => {
    expect(isInteractive({ ...base, started: true, netState: 'online', welcomed: false })).toBe(false);
  });

  it('is not interactive online after Welcome but before the first snapshot', () => {
    expect(isInteractive({ ...base, started: true, netState: 'online', welcomed: true, firstSnapshot: false })).toBe(false);
  });

  it('is interactive online once open, welcomed and the first snapshot arrived', () => {
    expect(isInteractive({ ...base, started: true, netState: 'online', welcomed: true, firstSnapshot: true })).toBe(true);
  });

  it('falls back out of interactive while reconnecting even after a prior welcome', () => {
    expect(isInteractive({ ...base, started: true, netState: 'reconnecting', welcomed: true, firstSnapshot: true })).toBe(false);
  });
});

describe('connectStatusKey', () => {
  it('shows nothing before Play', () => {
    expect(connectStatusKey({ ...base, started: false })).toBeNull();
  });

  it('shows nothing offline', () => {
    expect(connectStatusKey({ ...base, started: true, offline: true })).toBeNull();
  });

  it('shows connecting while the socket opens', () => {
    expect(connectStatusKey({ ...base, started: true, netState: 'connecting' })).toBe('coop.connect_connecting');
  });

  it('shows reconnecting while the socket retries', () => {
    expect(connectStatusKey({ ...base, started: true, netState: 'reconnecting' })).toBe('coop.connect_reconnecting');
  });

  it('shows ready in the brief window between Welcome and the first snapshot', () => {
    expect(connectStatusKey({ ...base, started: true, netState: 'online', welcomed: true, firstSnapshot: false })).toBe('coop.connect_ready');
  });

  it('shows nothing once fully interactive', () => {
    expect(connectStatusKey({ ...base, started: true, netState: 'online', welcomed: true, firstSnapshot: true })).toBeNull();
  });
});
