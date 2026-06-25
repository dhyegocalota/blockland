// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateButtonOnTouch } from './touch-activate';

afterEach(() => { document.body.innerHTML = ''; });

describe('activateButtonOnTouch', () => {
  it('clicks the enclosing .btn and reports it activated (so the joystick + tap works together)', () => {
    const button = document.createElement('button');
    button.className = 'btn';
    const inner = document.createElement('span');
    button.appendChild(inner);
    document.body.appendChild(button);
    const onClick = vi.fn();
    button.addEventListener('click', onClick);

    // A tap landing on the inner span still activates the button (closest walks up).
    expect(activateButtonOnTouch(inner)).toBe(true);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does nothing for a touch outside any .btn', () => {
    const other = document.createElement('div');
    document.body.appendChild(other);
    expect(activateButtonOnTouch(other)).toBe(false);
    expect(activateButtonOnTouch(null)).toBe(false);
  });
});
