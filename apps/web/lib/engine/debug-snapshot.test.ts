import { describe, expect, it } from 'vitest';
import { OFFLINE_ONLINE, OFFLINE_STATE, buildDebugSnapshot } from './debug-snapshot';

describe('buildDebugSnapshot', () => {
  it('rounds fps and coordinates', () => {
    const snap = buildDebugSnapshot({
      fps: 59.6, x: 1.239, y: 2.001, z: -3.456, chunks: 12, tenant: 'acme', frontVersion: 'abc1234', coop: null,
    });
    expect(snap.fps).toBe(60);
    expect(snap.x).toBe(1.24);
    expect(snap.y).toBe(2);
    expect(snap.z).toBe(-3.46);
    expect(snap.chunks).toBe(12);
    expect(snap.tenant).toBe('acme');
    expect(snap.frontVersion).toBe('abc1234');
  });

  it('reads offline when there is no co-op connection', () => {
    const snap = buildDebugSnapshot({
      fps: 30, x: 0, y: 0, z: 0, chunks: 4, tenant: 'acme', frontVersion: 'dev', coop: null,
    });
    expect(snap.ping).toBe(0);
    expect(snap.state).toBe(OFFLINE_STATE);
    expect(snap.online).toBe(OFFLINE_ONLINE);
    expect(snap.backendVersion).toBe(OFFLINE_STATE);
  });

  it('carries the live co-op network fields including the backend version', () => {
    const snap = buildDebugSnapshot({
      fps: 30, x: 0, y: 0, z: 0, chunks: 4, tenant: 'acme', frontVersion: 'dev',
      coop: { ping: 42, state: 'open', onlineCount: 7, backendVersion: 'srv9' },
    });
    expect(snap.ping).toBe(42);
    expect(snap.state).toBe('open');
    expect(snap.online).toBe(7);
    expect(snap.backendVersion).toBe('srv9');
  });
});
