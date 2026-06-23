// Player world actions: the thin wirer that assembles the single-purpose action modules onto the
// shared GameRuntime — block break/place/dig (block-actions), the magic-structure stamp
// (structure-placement), the stars/record persistence (scoreboard-runtime) — and owns the one
// concern left over: the in-place world reset.
import { createBlockActions } from './block-actions';
import { createStructurePlacement } from './structure-placement';
import { createScoreboard } from './rendering/scoreboard-runtime';
import type { GameRuntime } from './runtime';

export function createActions(runtime: GameRuntime): void {
  createScoreboard(runtime);
  createBlockActions(runtime);
  createStructurePlacement(runtime);

  // The admin wiped the world: rebuild it in place (like a fresh boot) and respawn, so every player
  // resets without being kicked back to the lobby. The server's reset already cleared its own world
  // and creatures; the local creatures (single-player) and poofs are cleared to match.
  runtime.resetLocalWorld = function resetLocalWorld(): void {
    const { player } = runtime.state;
    runtime.chime();
    runtime.world.reset();
    runtime.updateChunks(true);
    runtime.processMeshQueue(runtime.isTouch ? 24 : 60);
    runtime.poofRuntime.clear();
    runtime.heartDropRuntime.clear();
    runtime.heartDrops.length = 0;
    player.pos.copy(runtime.spawnPoint());
    player.vel.set(0, 0, 0);
    runtime.savePos();
  };
}
