// Touch joystick math, pure: from the touch point and the knob centre/radius, the clamped knob
// offset (kept inside the ring) and the normalized move vector handed to moveVector. The touch events
// and the DOM transform stay in the glue; this is geometry only, unit-tested.

export interface JoystickReading {
  // Knob offset in pixels, clamped to the ring radius.
  knobX: number;
  knobY: number;
  // Normalized move axes in [-1, 1].
  moveX: number;
  moveY: number;
}

export function readJoystick({
  touchX, touchY, centerX, centerY, radius,
}: {
  touchX: number;
  touchY: number;
  centerX: number;
  centerY: number;
  radius: number;
}): JoystickReading {
  const dx = touchX - centerX;
  const dy = touchY - centerY;
  const length = Math.hypot(dx, dy) || 1;
  const clamped = Math.min(length, radius);
  const knobX = (dx / length) * clamped;
  const knobY = (dy / length) * clamped;
  return { knobX, knobY, moveX: knobX / radius, moveY: knobY / radius };
}
