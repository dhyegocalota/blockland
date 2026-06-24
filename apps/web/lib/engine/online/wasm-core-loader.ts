// Loads + async-inits the gitignored wasm-bindgen `--target web` module (built by `npm run build:wasm`
// into `lib/wasm/`) and constructs a `WasmCore`. The generated artifacts are absent at typecheck time in
// CI, so the module surface is declared here (see `wasm-core-loader.d.ts`) and the actual code is reached
// through a dynamic import the bundler resolves at build time. Client-only: it touches `fetch`/wasm.

// The exact `WasmCore`/`OutboundMessage`/`OutboundKind` surface the generated bindings expose (mirrors
// `lib/wasm/game_core_wasm.d.ts`). Kept here so the driver is typed even when the artifacts aren't built.
export enum OutboundKind {
  Json = 0,
  Binary = 1,
}

export interface OutboundMessage {
  readonly kind: OutboundKind;
  readonly json: string;
  readonly binary: Uint8Array;
}

export interface WasmCore {
  add_local_player(name: string, look: string): number;
  input(playerId: number, msg: string, nowMs: number): void;
  tick(nowMs: number, wallMs: number, dt: number): boolean;
  drain_outbound(): OutboundMessage[];
  chunk_edits(cx: number, cz: number): Int32Array;
  world_blob(): Uint8Array;
  free(): void;
}

interface WasmModule {
  default(): Promise<unknown>;
  WasmCore: new (seed: number, config: string, nowMs: number, wallMs: number, debug: boolean) => WasmCore;
}

let modulePromise: Promise<WasmModule> | null = null;

// Import + init the wasm module once (the init promise is memoized so repeated offline sessions reuse the
// instantiated module). `@vite-ignore`/`webpackIgnore` are NOT set: the bundler must include the wasm.
async function loadModule(): Promise<WasmModule> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const mod = (await import('../../wasm/game_core_wasm.js')) as unknown as WasmModule;
    await mod.default();
    return mod;
  })();
  return modulePromise;
}

export interface WasmCoreInit {
  seed: number;
  config: string;
  nowMs: number;
  wallMs: number;
  debug: boolean;
}

export async function createWasmCore(init: WasmCoreInit): Promise<WasmCore> {
  const mod = await loadModule();
  return new mod.WasmCore(init.seed, init.config, init.nowMs, init.wallMs, init.debug);
}
