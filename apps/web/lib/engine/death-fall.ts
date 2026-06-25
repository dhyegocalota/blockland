// First-person death fall: while the player is down in the server's post-death pause, the camera rolls
// onto its side and sinks toward the ground, then snaps back on respawn. Pure timing math (no three.js)
// so it is unit-tested; the renderer glue just feeds it the clock and applies the returned offsets.
// Online and offline run the same loop, so the fall is identical in both. The duration is the SAME
// DEATH_FALL the server runs, code-generated from Rust so it can never drift.
import { DEATH_FALL_MS } from './constants.gen';

export { DEATH_FALL_MS };
const MAX_ROLL = Math.PI / 2.2; // almost flat on the ground
const MAX_DROP = 1.1; // eye sinks ~1.1 blocks toward the feet

export interface DeathFall {
  roll: number; // radians to roll the camera about its view axis
  drop: number; // blocks to lower the camera toward the ground
}

const NO_FALL: DeathFall = { roll: 0, drop: 0 };

export function deathFall(deadSince: number | null, now: number): DeathFall {
  if (deadSince === null) return NO_FALL;
  const t = Math.min(1, Math.max(0, (now - deadSince) / DEATH_FALL_MS));
  // Ease-out so the fall lands softly instead of snapping flat.
  const eased = 1 - (1 - t) * (1 - t);
  return { roll: eased * MAX_ROLL, drop: eased * MAX_DROP };
}
