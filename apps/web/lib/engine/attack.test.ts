import { describe, expect, it } from 'vitest';
import { attackTick } from './attack';

describe('attackTick', () => {
  it('does not fire and resets the timer while not attacking', () => {
    expect(attackTick({ attacking: false, sinceLast: 999, repeatMs: 250, dt: 100 })).toEqual({ fire: false, sinceLast: 0 });
  });

  it('accumulates dt without firing until the cadence is reached', () => {
    expect(attackTick({ attacking: true, sinceLast: 0, repeatMs: 250, dt: 100 })).toEqual({ fire: false, sinceLast: 100 });
    expect(attackTick({ attacking: true, sinceLast: 100, repeatMs: 250, dt: 100 })).toEqual({ fire: false, sinceLast: 200 });
  });

  it('fires once the cadence elapses and carries the remainder forward', () => {
    expect(attackTick({ attacking: true, sinceLast: 200, repeatMs: 250, dt: 80 })).toEqual({ fire: true, sinceLast: 30 });
  });
});
