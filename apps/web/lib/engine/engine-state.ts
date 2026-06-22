// The engine's mutable runtime state: the local player, the held keys + joystick, the room flags
// (server-authoritative online, local toggles offline) and the loop bookkeeping. game-engine.ts holds
// one instance and mutates its fields in place — pulling it out of the closure keeps the "what the
// engine remembers this tick" in one typed shape, separate from the three.js/DOM glue that drives it.
import { Vec3 } from './vec3';
import { MAX_HEARTS } from './constants';

export interface Player {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  fly: boolean;
  hearts: number;
  stars: number;
  bag: number;
  hurtCooldown: number;
}

export interface Joystick {
  active: boolean;
  x: number;
  y: number;
  id: number | null;
  cx: number;
  cy: number;
  r: number;
}

export interface EngineState {
  player: Player;
  keys: Record<string, boolean>;
  joystick: Joystick;
  // Selected hotbar block id.
  selected: number;
  // Room settings — server-authoritative in co-op, local toggles offline.
  peaceful: boolean;
  pvp: boolean;
  chatEnabled: boolean;
  approvalRequired: boolean;
  // Block resources OFFLINE only: infinite by default (solo sandbox + admins build freely).
  infiniteResources: boolean;
  // Loop bookkeeping.
  fps: number;
  paused: boolean;
  started: boolean;
  disposed: boolean;
  rafId: number;
}

export function createEngineState({ spawn }: { spawn: Vec3 }): EngineState {
  return {
    player: {
      pos: spawn.clone(),
      vel: new Vec3(),
      yaw: Math.PI, pitch: -0.2,
      onGround: false, fly: false,
      hearts: MAX_HEARTS, stars: 0, bag: 0, hurtCooldown: 0,
    },
    keys: {},
    joystick: { active: false, x: 0, y: 0, id: null, cx: 0, cy: 0, r: 50 },
    selected: 1,
    peaceful: true,
    pvp: false,
    chatEnabled: true,
    approvalRequired: false,
    infiniteResources: true,
    fps: 0,
    paused: false,
    started: false,
    disposed: false,
    rafId: 0,
  };
}
