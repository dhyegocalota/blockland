import { describe, expect, it } from 'vitest';
import { readJoystick } from './joystick';

describe('readJoystick', () => {
  it('reads a partial push as a fraction of the radius', () => {
    const reading = readJoystick({ touchX: 25, touchY: 0, centerX: 0, centerY: 0, radius: 50 });
    expect(reading.knobX).toBe(25);
    expect(reading.moveX).toBe(0.5);
    expect(reading.moveY).toBe(0);
  });

  it('clamps the knob to the ring at full push', () => {
    const reading = readJoystick({ touchX: 100, touchY: 0, centerX: 0, centerY: 0, radius: 50 });
    expect(reading.knobX).toBe(50);
    expect(reading.moveX).toBe(1);
  });

  it('centres when the touch is on the centre', () => {
    const reading = readJoystick({ touchX: 0, touchY: 0, centerX: 0, centerY: 0, radius: 50 });
    expect(reading).toEqual({ knobX: 0, knobY: 0, moveX: 0, moveY: 0 });
  });
});
