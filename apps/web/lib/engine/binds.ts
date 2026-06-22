// Input wiring (dependency-inverted): given a typed bag of callbacks + the abort signal, this attaches
// the keyboard/mouse listeners that drive the engine. It depends only on the InputBinds interface, never
// on game-engine internals, so the engine passes concrete handlers in and binds.ts stays glue-only. The
// listeners' guards (pointer-lock gate, typing-in-field) are preserved byte-for-byte; the pure pitch
// clamp is split out + unit-tested here.

// Look pitch is clamped just shy of straight up/down so the camera never flips.
const MAX_PITCH = 1.5;
export function clampPitch(pitch: number): number {
  return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
}

export interface InputBinds {
  canvas: HTMLCanvasElement;
  isTouch: boolean;
  // True while a text input is focused — keystrokes go to the field, not the game.
  typingInField(): boolean;
  // True while the pointer is locked to the canvas (mouse look + click-to-act active).
  pointerLocked(): boolean;
  keyDown(code: string): void;
  keyUp(code: string): void;
  hotkey(event: KeyboardEvent): void;
  look(movementX: number, movementY: number): void;
  primaryAction(): void;
  placeBlock(): void;
  lockPointer(): void;
  resize(): void;
}

export function bindWindowInput(binds: InputBinds, signal: AbortSignal): void {
  const { canvas, isTouch } = binds;

  addEventListener('keydown', (e) => {
    if (binds.typingInField()) return;
    binds.keyDown(e.code);
    binds.hotkey(e);
  }, { signal });
  addEventListener('keyup', (e) => { binds.keyUp(e.code); }, { signal });

  canvas.addEventListener('click', () => { if (!isTouch) binds.lockPointer(); }, { signal });
  addEventListener('mousemove', (e) => {
    if (!binds.pointerLocked()) return;
    binds.look(e.movementX, e.movementY);
  }, { signal });
  addEventListener('mousedown', (e) => {
    if (!binds.pointerLocked()) return;
    if (e.button === 0) binds.primaryAction();
    if (e.button === 2) binds.placeBlock();
  }, { signal });
  addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
  addEventListener('resize', binds.resize, { signal });
}
