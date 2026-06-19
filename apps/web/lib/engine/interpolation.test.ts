import { describe, expect, it } from 'vitest';
import { INTERP_DELAY_MS, RemoteInterpolator, type RemoteSample } from './interpolation';

const sample = (over: Partial<RemoteSample> & { t: number }): RemoteSample => ({
  x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ...over,
});

describe('RemoteInterpolator', () => {
  it('returns null with no samples', () => {
    expect(new RemoteInterpolator().sampleAt(1000)).toBeNull();
  });

  it('holds the only sample before enough history exists', () => {
    const interp = new RemoteInterpolator();
    interp.push(sample({ t: 1000, x: 5 }));
    expect(interp.sampleAt(1000)?.x).toBe(5);
  });

  it('lerps position between the two straddling samples', () => {
    const interp = new RemoteInterpolator();
    interp.push(sample({ t: 1000, x: 0 }));
    interp.push(sample({ t: 1200, x: 10 }));
    const pose = interp.sampleAt(1200 + INTERP_DELAY_MS - 100);
    expect(pose?.x).toBeCloseTo(5, 5);
  });

  it('clamps to the newest sample once render time passes it', () => {
    const interp = new RemoteInterpolator();
    interp.push(sample({ t: 1000, x: 0 }));
    interp.push(sample({ t: 1200, x: 10 }));
    expect(interp.sampleAt(5000)?.x).toBe(10);
  });

  it('clamps to the oldest sample for render times before it', () => {
    const interp = new RemoteInterpolator();
    interp.push(sample({ t: 1000, x: 3 }));
    interp.push(sample({ t: 1200, x: 9 }));
    expect(interp.sampleAt(1000)?.x).toBe(3);
  });

  it('takes the short way around when lerping yaw across the wrap boundary', () => {
    const interp = new RemoteInterpolator();
    interp.push(sample({ t: 1000, yaw: -3 }));
    interp.push(sample({ t: 1200, yaw: 3 }));
    const pose = interp.sampleAt(1200 + INTERP_DELAY_MS - 100);
    const wrapped = ((pose!.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    expect(Math.min(wrapped, Math.PI * 2 - wrapped)).toBeGreaterThan(3);
  });

  it('ignores out-of-order and duplicate samples', () => {
    const interp = new RemoteInterpolator();
    interp.push(sample({ t: 1200, x: 10 }));
    interp.push(sample({ t: 1000, x: 0 }));
    interp.push(sample({ t: 1200, x: 99 }));
    expect(interp.sampleAt(5000)?.x).toBe(10);
  });

  it('drops samples older than the buffer window but keeps a lerp pair', () => {
    const interp = new RemoteInterpolator();
    interp.push(sample({ t: 0 }));
    interp.push(sample({ t: 1500, x: 1 }));
    interp.push(sample({ t: 3000, x: 2 }));
    expect(interp.sampleAt(0)?.x).toBe(1);
  });
});
