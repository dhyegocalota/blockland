// The engine's control interfaces, shared between the React HUD, the headless lobby connection and the
// runtime modules. They live here (not in game-engine.ts) so the runtime modules can type the bridge
// without importing the composition root — keeping the dependency arrow one-way (builder -> modules).
import type { Appearance, CoopHud } from '../coop';
import type { Role } from '../protocol';
import type { DebugSnapshot } from './debug-snapshot';

// The admin command surface shared by the in-game engine and the headless lobby connection, so the
// same useRoomAdmin dispatch drives both.
export interface RoomAdminApi {
  setAdminPeace(on: boolean): void;
  setAdminStructure(kind: string, allowed: boolean): void;
  setAdminPvp(on: boolean): void;
  setAdminChat(on: boolean): void;
  kickPlayer(id: number): void;
  banPlayer(id: number): void;
  reportPlayer(id: number): void;
  resetWorld(): void;
  resetScores(): void;
  suspendRoom(on: boolean): void;
  setRole(id: number, role: Role): void;
  setApprovalRequired(on: boolean): void;
  approvePlayer(accountId: string): void;
  rejectPlayer(accountId: string): void;
  unban(ip: string): void;
  setLimits(playtimeLimitMin: number, playtimeWindowH: number): void;
  setModes(onlineAllowed: boolean, offlineAllowed: boolean): void;
}

// The bridge connects the React HUD to the engine: the HUD supplies the player name (resolved at
// connect time so late edits to the name field count) and receives net status / chat updates; the
// engine exposes chat sending and a live debug snapshot for F3.
// The control surface the engine binds back to the React HUD: chat, admin commands, debug snapshot.
export interface GameApi extends RoomAdminApi {
  sendChat(text: string): void;
  setInfiniteResources(on: boolean): void;
  returnToSpawn(): void;
  chime(): void;
  debugSnapshot(): DebugSnapshot;
  // Assembles the pasteable plain-text diagnostics report (live connection state + the recent-events
  // ring) for the "copy debug report" button.
  debugReport(): string;
}

export interface CoopBridge {
  resolveName(): string;
  resolveAppearance(): Appearance;
  resolveClaim(name: string): string;
  // True when the player chose single-player on the start screen: never connect, simulate locally.
  resolveOffline(): boolean;
  hud: CoopHud;
  bind(api: GameApi): void;
}
