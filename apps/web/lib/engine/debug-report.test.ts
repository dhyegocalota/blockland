import { describe, expect, it } from 'vitest';
import {
  DEBUG_RING_CAPACITY,
  DebugEventDir,
  DebugEventKind,
  DebugEventRing,
  DivergenceTracker,
  POSITION_DIVERGENCE_THRESHOLD,
  formatDebugReport,
  positionDivergence,
  type DebugEvent,
} from './debug-report';

describe('DebugEventRing', () => {
  it('stamps each pushed event with the injected clock', () => {
    let clock = 100;
    const ring = new DebugEventRing(4, () => clock);
    ring.push({ dir: DebugEventDir.Send, kind: DebugEventKind.Dig, cell: { x: 1, y: 2, z: 3 } });
    clock = 250;
    ring.push({ dir: DebugEventDir.State, kind: DebugEventKind.NetState, text: 'online' });
    expect(ring.list().map((e) => e.at)).toEqual([100, 250]);
  });

  it('keeps newest last and drops the oldest past capacity', () => {
    let clock = 0;
    const ring = new DebugEventRing(3, () => (clock += 1));
    for (let id = 1; id <= 5; id += 1) ring.push({ dir: DebugEventDir.Send, kind: DebugEventKind.Hit, id });
    expect(ring.list().map((e) => e.id)).toEqual([3, 4, 5]);
    expect(ring.list()).toHaveLength(3);
  });

  it('defaults to DEBUG_RING_CAPACITY and clears', () => {
    const ring = new DebugEventRing(undefined, () => 1);
    for (let i = 0; i < DEBUG_RING_CAPACITY + 10; i += 1) ring.push({ dir: DebugEventDir.Send, kind: DebugEventKind.Move });
    expect(ring.list()).toHaveLength(DEBUG_RING_CAPACITY);
    ring.clear();
    expect(ring.list()).toEqual([]);
  });

  it('list returns a copy, not the live buffer', () => {
    const ring = new DebugEventRing(2, () => 0);
    ring.push({ dir: DebugEventDir.Send, kind: DebugEventKind.Move });
    const first = ring.list();
    ring.push({ dir: DebugEventDir.Send, kind: DebugEventKind.Move });
    expect(first).toHaveLength(1);
  });
});

describe('positionDivergence', () => {
  it('is the straight-line distance between client and server positions', () => {
    expect(positionDivergence({ client: { x: 0, y: 0, z: 0 }, server: { x: 3, y: 4, z: 0 } })).toBe(5);
  });

  it('is zero when the positions agree', () => {
    expect(positionDivergence({ client: { x: 7, y: 1, z: -2 }, server: { x: 7, y: 1, z: -2 } })).toBe(0);
  });
});

describe('DivergenceTracker', () => {
  it('reports the transition into and out of divergence exactly once each', () => {
    const tracker = new DivergenceTracker(POSITION_DIVERGENCE_THRESHOLD);
    expect(tracker.update(0.5)).toBeNull();
    expect(tracker.update(5)).toBe('diverged');
    expect(tracker.update(6)).toBeNull();
    expect(tracker.update(0.2)).toBe('recovered');
    expect(tracker.update(0.1)).toBeNull();
  });
});

describe('formatDebugReport', () => {
  const baseEvents: DebugEvent[] = [
    { at: 9_000, dir: DebugEventDir.Send, kind: DebugEventKind.Move, pos: { x: 10, y: 2, z: 10 } },
    { at: 9_500, dir: DebugEventDir.Send, kind: DebugEventKind.Dig, pos: { x: 10, y: 2, z: 10 }, cell: { x: 11, y: 2, z: 10 } },
    { at: 9_800, dir: DebugEventDir.Recv, kind: DebugEventKind.Error, text: 'too_far' },
  ];

  it('flags the position delta as STALE past the threshold and prints the ring newest last', () => {
    const report = formatDebugReport({
      at: 10_000,
      tenant: 'acme',
      frontVersion: 'abc1234',
      backendVersion: 'srv9',
      netState: 'online',
      ping: 42,
      online: 3,
      clientPos: { x: 10, y: 2, z: 10 },
      serverPos: { x: 4, y: 2, z: 10 },
      hp: 8,
      events: baseEvents,
    });
    expect(report).toBe(
      [
        '— Blockland debug report —',
        'at: 10000',
        'tenant: acme',
        'front: abc1234',
        'backend: srv9',
        'net: online',
        'ping: 42ms',
        'online: 3',
        'hp: 8',
        'client pos: 10.00, 2.00, 10.00',
        'server pos: 4.00, 2.00, 10.00',
        'pos delta: 6.00 STALE',
        'events (3, newest last):',
        '  -1000ms send/move pos=(10.00, 2.00, 10.00)',
        '  -500ms send/dig cell=(11.00, 2.00, 10.00) pos=(10.00, 2.00, 10.00)',
        '  -200ms recv/error too_far',
      ].join('\n'),
    );
  });

  it('marks the server position absent before the first snapshot', () => {
    const report = formatDebugReport({
      at: 1_000,
      tenant: 'acme',
      frontVersion: 'dev',
      backendVersion: 'offline',
      netState: 'connecting',
      ping: 0,
      online: 1,
      clientPos: { x: 0, y: 0, z: 0 },
      serverPos: null,
      hp: 10,
      events: [],
    });
    expect(report).toContain('server pos: (no snapshot yet)');
    expect(report).not.toContain('pos delta');
    expect(report).toContain('events (0, newest last):');
    expect(report).toContain('  (none)');
  });

  it('does not flag a STALE delta when client and server agree', () => {
    const report = formatDebugReport({
      at: 0,
      tenant: 'acme',
      frontVersion: 'dev',
      backendVersion: 'srv',
      netState: 'online',
      ping: 10,
      online: 1,
      clientPos: { x: 5, y: 1, z: 5 },
      serverPos: { x: 5, y: 1, z: 5 },
      hp: 10,
      events: [],
    });
    expect(report).toContain('pos delta: 0.00');
    expect(report).not.toContain('STALE');
  });
});
