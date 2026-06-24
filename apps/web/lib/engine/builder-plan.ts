// The builder's offline-vs-online wiring decision — pure so it is unit-tested in isolation.
// `coopEnabled` reproduces the engine's original gate (`!!serverUrl && !!bridge`): co-op needs both a
// configured server and a HUD bridge to connect through. `.offline()` forces offline by dropping the
// bridge from the plan. (Creatures are server-authoritative in BOTH modes now — the WASM core owns them
// offline too — so there is no boot-time local seeding to gate.)

export type EngineMode = 'offline' | 'online';

export interface CoopPlan {
  coopEnabled: boolean;
}

export function resolveCoopPlan({ serverUrl, hasBridge, mode }: { serverUrl: string | undefined; hasBridge: boolean; mode: EngineMode }): CoopPlan {
  const coopEnabled = mode === 'online' && !!serverUrl && hasBridge;
  return { coopEnabled };
}
