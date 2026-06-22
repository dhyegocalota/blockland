// Single-player / offline mode. With no server to grant roles, every offline player IS the room admin
// and owns the room locally; the world's creatures are seeded locally too (online gets them from the
// server). Online never enters here (coop is set), so the two modes can't collide.
import type { GameRuntime } from '../runtime';

export function createOfflineMode(runtime: GameRuntime): void {
  runtime.grantOfflineAdmin = function grantOfflineAdmin(): void {
    runtime.bridge?.hud.onRole({ admin: true, moderator: false });
    runtime.bridge?.hud.onRoomState(runtime.currentRoom());
  };

  runtime.enterOfflineMode = function enterOfflineMode(): void {
    if (!runtime.creatures.length) runtime.populateCreatures();
    runtime.grantOfflineAdmin();
  };
}
