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
  // Press fires the first hit immediately and starts hold-to-attack; release stops it (the loop repeats
  // between them at ATTACK_REPEAT_MS).
  attackDown(): void;
  attackUp(): void;
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
    if (e.button === 0) binds.attackDown();
    if (e.button === 2) binds.placeBlock();
  }, { signal });
  addEventListener('mouseup', (e) => { if (e.button === 0) binds.attackUp(); }, { signal });
  // Losing the pointer lock or window focus must stop a held attack so it never sticks on.
  document.addEventListener('pointerlockchange', () => { if (!binds.pointerLocked()) binds.attackUp(); }, { signal });
  addEventListener('blur', binds.attackUp, { signal });
  addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
  addEventListener('resize', binds.resize, { signal });
}
