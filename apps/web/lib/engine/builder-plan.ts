// The builder's offline-vs-online wiring decision — pure so it is unit-tested in isolation.
// `coopEnabled` reproduces the engine's original gate (`!!serverUrl && !!bridge`): co-op needs both a
// configured server and a HUD bridge to connect through. `populateAtBoot` is its mirror — local
// (offline) creatures are seeded at boot only when co-op is NOT enabled, because online the
// server owns every creature. `.offline()` forces offline by dropping the bridge from the plan.

export type EngineMode = 'offline' | 'online';

export interface CoopPlan {
  coopEnabled: boolean;
  populateAtBoot: boolean;
}

export function resolveCoopPlan({ serverUrl, hasBridge, mode }: { serverUrl: string | undefined; hasBridge: boolean; mode: EngineMode }): CoopPlan {
  const coopEnabled = mode === 'online' && !!serverUrl && hasBridge;
  return { coopEnabled, populateAtBoot: !coopEnabled };
}
