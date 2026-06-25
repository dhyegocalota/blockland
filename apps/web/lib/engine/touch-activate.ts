// Multi-touch HUD activation: while one finger holds the joystick, the browser does not synthesize a
// 'click' for a second finger tapping a button, so the action-row buttons are fired on touchstart
// instead. Given a touch target, click the enclosing `.btn` (if any) and report whether it did, so the
// caller can preventDefault the (suppressed) ghost click only when a button was actually activated.
export function activateButtonOnTouch(target: EventTarget | null): boolean {
  const button = (target as HTMLElement | null)?.closest?.('.btn') as HTMLButtonElement | null;
  if (!button) return false;
  button.click();
  return true;
}
