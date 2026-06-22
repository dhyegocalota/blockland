// HUD + DOM wiring, dependency-inverted onto the shared GameRuntime: the WebAudio blips/chime, the
// hotbar, the toast, the controls + build-menu modals, the fly toggle, hotkeys, pointer-lock, viewport
// resize and the touch controls. Creating it attaches the DOM listeners (gated by the engine's abort
// signal) exactly as the closure did — so it must be created after el()/canvas are wired and before the
// game starts. Pure pieces (hotbarCountLabel, readJoystick, clampPitch) are unit-tested elsewhere.
import { t } from '../../i18n';
import { debug } from '../../log';
import { BLOCKS, blockById } from '../blocks';
import {
  CHIME_GAP_MS, CHIME_HIGH_FREQ, CHIME_LOW_FREQ, CHIME_NOTE_DURATION, FACE_ID,
  TOAST_DURATION_MS, TOUCH_LOOK_SENSITIVITY,
} from '../constants';
import { renderBlockCanvas } from '../textures';
import { hotbarCountLabel } from '../inventory';
import { readJoystick } from '../joystick';
import { clampPitch } from '../binds';
import type { StructureKind } from '../structures';
import type { GameRuntime } from '../runtime';

interface AudioWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

export function createHud(runtime: GameRuntime): void {
  const { canvas, signal, isTouch, el } = runtime;
  const win = window as unknown as AudioWindow;
  const { player, keys, joystick } = runtime.state;

  runtime.typingInField = (): boolean => document.activeElement instanceof HTMLInputElement;

  // ---------- Sound ----------
  runtime.blip = function blip(freq: number, dur: number): void {
    if (!runtime.audio) {
      const Ctor = window.AudioContext || win.webkitAudioContext;
      if (!Ctor) throw new Error('AudioContext unsupported');
      runtime.audio = new Ctor();
    }
    const audio = runtime.audio;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.value = 0.06; o.connect(g); g.connect(audio.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
    o.stop(audio.currentTime + dur);
  };

  // A friendly two-note rising cue for room-wide events (world reset, scores reset, suspend).
  runtime.chime = function chime(): void {
    runtime.blip(CHIME_LOW_FREQ, CHIME_NOTE_DURATION);
    setTimeout(() => runtime.blip(CHIME_HIGH_FREQ, CHIME_NOTE_DURATION), CHIME_GAP_MS);
  };

  // ---------- HUD ----------
  const hotbar = el('hotbar');
  runtime.buildHotbar = function buildHotbar(faceUrl: string): void {
    for (const b of BLOCKS) {
      if (!b) continue;
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.id = String(b.id);
      const swatch = document.createElement('div');
      swatch.className = 'swatch';
      if (b.id === FACE_ID) swatch.style.background = `center/cover url(${faceUrl})`;
      else { swatch.style.background = `center/cover url(${renderBlockCanvas(b).toDataURL()})`; swatch.style.imageRendering = 'pixelated'; }
      slot.appendChild(swatch);
      const key = document.createElement('span'); key.className = 'key'; key.textContent = b.key; slot.appendChild(key);
      const name = document.createElement('span'); name.className = 'name'; name.textContent = runtime.blockName(b); slot.appendChild(name);
      const count = document.createElement('span'); count.className = 'count'; slot.appendChild(count);
      slot.addEventListener('click', () => runtime.selectSlot(b.id), { signal });
      hotbar.appendChild(slot);
    }
    runtime.updateHotbarCounts();
  };

  // Admins build freely, so their slots show no counter; regular players see how many of each block
  // they have banked (∞ would be misleading, so it is simply hidden when resources are infinite). Co-op
  // reads the server-authoritative inventory; offline reads the local BlockInventory.
  runtime.updateHotbarCounts = function updateHotbarCounts(): void {
    const infinite = runtime.coop ? runtime.coop.infinite : runtime.state.infiniteResources;
    for (const slot of [...hotbar.children] as HTMLElement[]) {
      const id = Number(slot.dataset.id);
      const badge = slot.querySelector<HTMLElement>('.count');
      if (!badge) continue;
      const count = runtime.coop ? runtime.coop.inventoryCount(id) : runtime.inventory.count(id);
      badge.textContent = hotbarCountLabel({ infiniteResources: infinite, count });
    }
  };

  runtime.selectSlot = function selectSlot(id: number): void {
    runtime.state.selected = id;
    [...hotbar.children].forEach((s) => s.classList.toggle('active', Number((s as HTMLElement).dataset.id) === id));
    const block = blockById(id);
    if (!block) throw new Error(`unknown block ${id}`);
    runtime.toast(t('toast.block_selected', { name: runtime.blockName(block) }));
  };

  const toastEl = el('toast');
  let toastTimer: ReturnType<typeof setTimeout>;
  runtime.toast = function toast(msg: string): void {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), TOAST_DURATION_MS);
  };

  runtime.toggleFly = function toggleFly(): void {
    player.fly = !player.fly;
    el('flyBtn').classList.toggle('on', player.fly);
    runtime.toast(player.fly ? t('toast.flying') : t('toast.walking'));
    debug('engine', 'fly toggled', { fly: player.fly });
  };
  el('flyBtn').addEventListener('click', (e) => { e.stopPropagation(); runtime.toggleFly(); }, { signal });

  // ---------- Input ----------
  runtime.lockPointer = function lockPointer(): void {
    if (!runtime.state.started || isTouch) return;
    Promise.resolve(canvas.requestPointerLock()).catch((err: unknown) => {
      debug('engine', 'pointer-lock denied', { reason: String(err) });
    });
  };
  runtime.resizeViewport = function resizeViewport(): void {
    runtime.camera.aspect = innerWidth / innerHeight;
    runtime.camera.updateProjectionMatrix();
    runtime.renderer.setSize(innerWidth, innerHeight);
  };

  runtime.setupTouchControls = function setupTouchControls(): void {
    document.body.classList.add('is-touch');
    let lookId: number | null = null, lx = 0, ly = 0;
    canvas.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      if (lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
    }, { passive: true, signal });
    canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== lookId) continue;
        player.yaw -= (t.clientX - lx) * TOUCH_LOOK_SENSITIVITY;
        player.pitch = clampPitch(player.pitch - (t.clientY - ly) * TOUCH_LOOK_SENSITIVITY);
        lx = t.clientX; ly = t.clientY;
      }
    }, { passive: true, signal });
    const endLook = (e: TouchEvent): void => { for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null; };
    canvas.addEventListener('touchend', endLook, { signal });
    canvas.addEventListener('touchcancel', endLook, { signal });

    const joyEl = el('joystick');
    const knob = el('joyKnob');
    const setKnob = (dx: number, dy: number): void => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };
    const moveJoy = (t: Touch): void => {
      const reading = readJoystick({ touchX: t.clientX, touchY: t.clientY, centerX: joystick.cx, centerY: joystick.cy, radius: joystick.r });
      joystick.x = reading.moveX; joystick.y = reading.moveY;
      setKnob(reading.knobX, reading.knobY);
    };
    joyEl.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      const rect = joyEl.getBoundingClientRect();
      joystick.active = true; joystick.id = t.identifier;
      joystick.cx = rect.left + rect.width / 2; joystick.cy = rect.top + rect.height / 2;
      joystick.r = rect.width / 2;
      moveJoy(t); e.preventDefault();
    }, { passive: false, signal });
    joyEl.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) if (t.identifier === joystick.id) moveJoy(t);
      e.preventDefault();
    }, { passive: false, signal });
    const endJoy = (e: TouchEvent): void => {
      for (const t of e.changedTouches) if (t.identifier === joystick.id) {
        joystick.active = false; joystick.id = null; joystick.x = 0; joystick.y = 0; setKnob(0, 0);
      }
    };
    joyEl.addEventListener('touchend', endJoy, { signal });
    joyEl.addEventListener('touchcancel', endJoy, { signal });

    const holdKey = (id: string, code: string): void => {
      const node = el(id);
      node.addEventListener('touchstart', (e) => { keys[code] = true; e.preventDefault(); }, { passive: false, signal });
      const up = (): void => { keys[code] = false; };
      node.addEventListener('touchend', up, { signal });
      node.addEventListener('touchcancel', up, { signal });
    };
    holdKey('btnUp', 'Space');
    holdKey('btnDown', 'ShiftLeft');
    const tapBtn = (id: string, fn: () => void): void => {
      el(id).addEventListener('touchstart', (e) => { fn(); e.preventDefault(); }, { passive: false, signal });
    };
    tapBtn('btnBreak', runtime.primaryAction);
    tapBtn('btnPlace', runtime.placeBlock);
  };

  runtime.handleHotkey = function handleHotkey(e: KeyboardEvent): void {
    if (e.code === 'Escape') { runtime.hideControls(); runtime.hideBuildMenu(); return; }
    const b = BLOCKS.find((bl) => bl && bl.key === e.key);
    if (b) runtime.selectSlot(b.id);
    if (e.code === 'KeyF') runtime.toggleFly();
    if (e.code === 'KeyV') runtime.toggleControls();
    if (e.code === 'KeyB') runtime.toggleBuildMenu();
  };

  // ---------- Controls modal ----------
  const controlsEl = el('controls');
  runtime.showControls = function showControls(): void {
    runtime.state.paused = true;
    controlsEl.hidden = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  };
  runtime.hideControls = function hideControls(): void {
    runtime.state.paused = false;
    controlsEl.hidden = true;
    if (runtime.state.started && !isTouch) runtime.lockPointer();
  };
  runtime.toggleControls = function toggleControls(): void { controlsEl.hidden ? runtime.showControls() : runtime.hideControls(); };
  el('helpBtn').addEventListener('click', (e) => { e.stopPropagation(); runtime.showControls(); }, { signal });
  el('closeControls').addEventListener('click', (e) => { e.stopPropagation(); runtime.hideControls(); }, { signal });
  controlsEl.addEventListener('click', (e) => { if (e.target === controlsEl) runtime.hideControls(); }, { signal });

  // ---------- Build menu ----------
  const buildMenuEl = el('buildMenu');
  runtime.showBuildMenu = function showBuildMenu(): void {
    runtime.state.paused = true;
    buildMenuEl.hidden = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  };
  runtime.hideBuildMenu = function hideBuildMenu(): void {
    runtime.state.paused = false;
    buildMenuEl.hidden = true;
    if (runtime.state.started && !isTouch) runtime.lockPointer();
  };
  runtime.toggleBuildMenu = function toggleBuildMenu(): void { buildMenuEl.hidden ? runtime.showBuildMenu() : runtime.hideBuildMenu(); };
  el('buildBtn').addEventListener('click', (e) => { e.stopPropagation(); runtime.showBuildMenu(); }, { signal });
  el('closeBuild').addEventListener('click', (e) => { e.stopPropagation(); runtime.hideBuildMenu(); }, { signal });
  buildMenuEl.addEventListener('click', (e) => { if (e.target === buildMenuEl) runtime.hideBuildMenu(); }, { signal });
  buildMenuEl.querySelectorAll<HTMLButtonElement>('.buildCard').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const kind = btn.dataset.kind;
      if (!kind) throw new Error('build card missing data-kind');
      if (runtime.blockedStructures.has(kind)) return;
      runtime.buildStructure(kind as StructureKind);
      runtime.hideBuildMenu();
    }, { signal });
  });
  // Hide blocked structure cards so a player never sees what an admin has blocked room-wide;
  // unblocked ones reappear. buildStructure still guards against a stale blocked pick.
  runtime.syncBuildMenu = function syncBuildMenu(): void {
    buildMenuEl.querySelectorAll<HTMLButtonElement>('.buildCard').forEach((btn) => {
      const kind = btn.dataset.kind;
      if (!kind) throw new Error('build card missing data-kind');
      btn.style.display = runtime.blockedStructures.has(kind) ? 'none' : '';
    });
  };
}
