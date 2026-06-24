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
  // The client input is now a BINARY `ClientMsg` frame (the shared `protocol::client_codec`), the same wire
  // the socket sends — encode through `encode_client_msg` (the wasm) before feeding it.
  input(playerId: number, msg: Uint8Array, nowMs: number): void;
  tick(nowMs: number, wallMs: number, dt: number): boolean;
  drain_outbound(): OutboundMessage[];
  chunk_edits(cx: number, cz: number): Int32Array;
  world_blob(): Uint8Array;
  free(): void;
}

// The stateful binary snapshot decoder (the single Rust decode the server encodes against). `decode`
// reconstructs each per-tick frame — keyframe or baseline-relative delta — into the packed `Float64Array`
// the TS unpacker reads (see `wasm-snapshot-decoder.ts`); an empty array means "emit nothing this frame"
// (a delta with no usable baseline). Throws on a corrupt/stale-version frame.
export interface WasmSnapshotDecoder {
  decode(bytes: Uint8Array): Float64Array;
  free(): void;
}

// A synchronous worldgen: the full procedural base of one chunk as a flat CHUNK*CHUNK*SIZE_Y byte array
// (the `lx + lz*CHUNK + y*CHUNK*CHUNK` layout the voxel store caches). The client store calls this ONCE
// per chunk to fill its base from the single Rust source, then overlays edits — all hot per-voxel reads
// stay in the TS cache (no wasm call per voxel/frame).
export type WorldgenChunk = (cx: number, cz: number) => Uint8Array;

// The single Rust client-message encoder (`protocol::client_codec`), exposed so the client NEVER hand-writes
// the wire: it builds a JSON `ClientMsg`, hands it here, and gets back the exact binary frame the socket
// sends (and the offline core feeds to `WasmCore::input`). Symmetric with the binary snapshots it decodes.
export type EncodeClientMsg = (json: string) => Uint8Array;

interface WasmModule {
  default(): Promise<unknown>;
  WasmCore: new (seed: number, config: string, nowMs: number, wallMs: number, debug: boolean) => WasmCore;
  SnapshotDecoder: new () => WasmSnapshotDecoder;
  worldgen_chunk: WorldgenChunk;
  encode_client_msg: EncodeClientMsg;
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

// Build a fresh stateful snapshot decoder on the already-inited module. The wasm is loaded for online AND
// offline (Stage 6b), so both the socket path and the offline core-drain can construct one.
export async function createSnapshotDecoder(): Promise<WasmSnapshotDecoder> {
  const mod = await loadModule();
  return new mod.SnapshotDecoder();
}

// Init the wasm (gating first paint) and return the synchronous chunk worldgen the voxel store fills its
// base from. The wasm now loads for ONLINE too (not only the offline core), so the procedural base always
// comes from the single Rust source. Awaited once during the engine load; later chunk streams call the
// returned function synchronously on the already-inited module.
export async function loadWorldgen(): Promise<WorldgenChunk> {
  const mod = await loadModule();
  return (cx, cz) => mod.worldgen_chunk(cx, cz);
}

// Build the synchronous client-message encoder on the already-inited module (the single Rust codec). Both
// the online socket path and the offline core encode every `ClientMsg` through it before sending/feeding —
// so neither side hand-writes the wire. Awaited once on connect (the wasm is inited at boot).
export async function createClientEncoder(): Promise<EncodeClientMsg> {
  const mod = await loadModule();
  return (json) => mod.encode_client_msg(json);
}
