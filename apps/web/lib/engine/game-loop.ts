// The update/physics/loop orchestration, dependency-inverted onto the shared GameRuntime: player
// movement + gravity + actor collision (blockIntoActors), the per-frame update() that steps physics and
// renders the view, the start() gate that reveals the HUD and kicks off co-op, and the rAF loop()
// that ticks everything on a frame budget. It also attaches the window input binds. Pure pieces
// (moveVector, moveAxis, blockVelocityIntoActors, nextFrame, smoothFps) are unit-tested; this is the glue.
import {
  EYE_HEIGHT, FLY_SPEED, GRAVITY, JUMP_SPEED, PLAYER_HEIGHT, PLAYER_RADIUS, WALK_SPEED, clampToWorld,
} from './constants';
import { debug } from '../log';
import { type Axis, moveAxis } from './physics';
import { blockVelocityIntoActors } from './actors';
import { moveVector } from './movement';
import { nextFrame, smoothFps } from './frame-cap';
import { bindWindowInput, clampPitch } from './binds';
import { MOUSE_LOOK_SENSITIVITY, POS_SAVE_MS, VOID_FALL_Y } from './engine-config';
import type { GameRuntime } from './runtime';

export function createGameLoop(runtime: GameRuntime): void {
  const { state, isTouch, canvas, signal } = runtime;
  const player = state.player;
  const keys = state.keys;
  const joystick = state.joystick;

  // ---------- Physics ----------
  const stepAxis = (axis: Axis, amount: number): void => moveAxis({ world: runtime.world, player, axis, amount });

  // Stop the local player from walking through remote players AND server creatures (velocity-only,
  // never adds motion) — monsters and animals are solid bodies you bump into, not ghosts.
  runtime.blockIntoActors = function blockIntoActors(): void {
    if (!runtime.coop) return;
    const players = runtime.coop.getColliders();
    const creatures = runtime.coop.getCreatures().map((c) => ({ x: c.x, y: c.y, z: c.z }));
    const actors = [...players, ...creatures];
    if (actors.length === 0) return;
    const blocked = blockVelocityIntoActors({
      x: player.pos.x,
      y: player.pos.y - EYE_HEIGHT,
      z: player.pos.z,
      vx: player.vel.x,
      vz: player.vel.z,
      radius: PLAYER_RADIUS,
      height: PLAYER_HEIGHT,
      actors,
      actorRadius: PLAYER_RADIUS,
    });
    player.vel.x = blocked.vx;
    player.vel.z = blocked.vz;
  };

  runtime.update = function update(dt: number): void {
    const move = moveVector({
      yaw: player.yaw, pitch: player.pitch, fly: player.fly,
      forward: !!(keys.KeyW || keys.ArrowUp), back: !!(keys.KeyS || keys.ArrowDown),
      right: !!(keys.KeyD || keys.ArrowRight), left: !!(keys.KeyA || keys.ArrowLeft),
      joystickActive: joystick.active, joystickX: joystick.x, joystickY: joystick.y,
    });

    if (player.fly) {
      player.vel.set(move.x, move.y, move.z).multiplyScalar(FLY_SPEED);
      if (keys.Space) player.vel.y = FLY_SPEED;
      if (keys.ShiftLeft || keys.ShiftRight) player.vel.y = -FLY_SPEED;
    } else {
      player.vel.x = move.x * WALK_SPEED;
      player.vel.z = move.z * WALK_SPEED;
      player.vel.y += GRAVITY * dt;
      if (keys.Space && player.onGround) { player.vel.y = JUMP_SPEED; player.onGround = false; }
    }

    runtime.blockIntoActors();

    player.onGround = false;
    stepAxis('x', player.vel.x * dt);
    stepAxis('z', player.vel.z * dt);
    stepAxis('y', player.vel.y * dt);

    if (player.pos.y < VOID_FALL_Y) { player.pos.copy(runtime.spawnPoint()); player.vel.set(0, 0, 0); }
    clampToWorld(player.pos);

    runtime.view.renderView({
      pose: { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch },
      aim: runtime.raycastVoxel(),
    });
  };

  bindWindowInput({
    canvas, isTouch,
    typingInField: runtime.typingInField,
    pointerLocked: () => document.pointerLockElement === canvas,
    keyDown: (code) => { keys[code] = true; },
    keyUp: (code) => { keys[code] = false; },
    hotkey: runtime.handleHotkey,
    look: (movementX, movementY) => {
      player.yaw -= movementX * MOUSE_LOOK_SENSITIVITY;
      player.pitch = clampPitch(player.pitch - movementY * MOUSE_LOOK_SENSITIVITY);
    },
    primaryAction: runtime.primaryAction,
    placeBlock: runtime.placeBlock,
    lockPointer: runtime.lockPointer,
    resize: runtime.resizeViewport,
  }, signal);

  if (isTouch) runtime.setupTouchControls();

  // ---------- Loop ----------
  runtime.loop = function loop(now: number): void {
    if (state.disposed) return;
    state.rafId = requestAnimationFrame(runtime.loop);
    const frame = nextFrame({ now, last: runtime.last });
    if (frame.skip) return;
    runtime.last = frame.last;
    const dt = frame.dt;
    state.fps = smoothFps({ fps: state.fps, dt });
    if (state.started && !state.paused) { runtime.update(dt); runtime.updateChunks(); runtime.processMeshQueue(isTouch ? 1 : 2); if (!runtime.coop) runtime.updateCreatures(dt); runtime.updatePoofs(dt); }
    if (runtime.coop) { runtime.coop.sendMove(runtime.localPose(), now); runtime.coop.update(now); }
    if (state.started && now - runtime.lastPosSave > POS_SAVE_MS) { runtime.savePos(); runtime.lastPosSave = now; }
    runtime.view.present();
  };

  runtime.start = function start(): void {
    state.started = true;
    runtime.el('start').style.display = 'none';
    ['#topbar', '#hotbar', '#actionRow', '#crosshair'].forEach((s) => {
      const node = document.querySelector<HTMLElement>(s);
      if (!node) throw new Error(`missing element ${s}`);
      node.style.opacity = '1';
    });
    if (isTouch) runtime.el('touchControls').style.display = 'block';
    if (!isTouch) runtime.lockPointer();
    runtime.blip(660, 0.12); setTimeout(() => runtime.blip(880, 0.14), 120);
    runtime.startCoop();
  };
}
