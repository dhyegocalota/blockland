// The engine's public surface + the one-line boot. Everything the running game does now lives in the
// cohesive lib/engine/* runtime modules; this file just re-exports the control interfaces the React HUD
// talks through and wires the boot via the fluent GameEngine builder (the composition root).
import { type Brand } from './tenants';
import { GameEngine } from './engine/game-engine-builder';
import { loadWorldgen } from './engine/online/wasm-core-loader';
import type { CoopBridge } from './engine/api';

export type { RoomAdminApi, GameApi, CoopBridge } from './engine/api';
export { STRUCTURE_DEFS, STRUCTURE_KINDS, type StructureKind } from './engine/structures';
export type { DebugSnapshot } from './engine/debug-snapshot';

// Boot the game for a tenant. With a bridge the builder wires online (co-op connects when a server
// is configured and the player didn't pick single-player); without one it stays a local sandbox.
// The wasm worldgen is inited first (gating first paint), so the voxel store's procedural base comes from
// the single Rust source for ONLINE and offline alike; later chunk fills are synchronous on the inited wasm.
export async function initGame(brand: Brand, bridge?: CoopBridge): Promise<(() => void) | undefined> {
  const worldgen = await loadWorldgen();
  // The lobby's Sozinho/Com amigos toggle flips this to offline at runtime via the bridge's resolveOffline.
  return GameEngine.builder().forTenant(brand).withWorldgen(worldgen).withBridge(bridge).online().build();
}
