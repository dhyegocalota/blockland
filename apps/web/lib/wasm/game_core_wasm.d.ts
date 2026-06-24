/* tslint:disable */
/* eslint-disable */

export enum OutboundKind {
  Json = 0,
  Binary = 1,
}

export class OutboundMessage {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * The JSON `ServerMsg` text, valid only when `kind == Json`.
   */
  readonly json: string;
  readonly kind: OutboundKind;
  /**
   * The binary snapshot blob, valid only when `kind == Binary`.
   */
  readonly binary: Uint8Array;
}

export class WasmCore {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * The encoded world diff (every edit, `sim::encode_edits` format) — a compact blob the JS side can
   * persist or hand back. Offline keeps no db, so this is the only way to snapshot the built world.
   */
  world_blob(): Uint8Array;
  /**
   * The current world edits for chunk `(cx, cz)` as a flat `[x,y,z,id, …]` `i32` array (id in the low
   * byte), the same per-chunk built-structure data the server streams — the renderer overlays these on
   * the procedural base it already generates locally.
   */
  chunk_edits(cx: number, cz: number): Int32Array;
  /**
   * Drain every queued outbound message (the room's Welcome/roster/edits/snapshots) for the JS loop to
   * apply, in the order the room produced them. Empties the queue.
   */
  drain_outbound(): OutboundMessage[];
  /**
   * Add the single local player and return its id. The player is admitted as the room ADMIN (offline
   * parity with the web `grantOfflineAdmin`): offline has one client, the player, who controls the world.
   * `name` may be empty (the room names a guest). `look` is a JSON `{skin,shirt,hair}`.
   */
  add_local_player(name: string, look: string): number;
  /**
   * Build an offline room from a JS-provided `seed` (reseeds the simulation RNG so spawns are
   * deterministic) and a JSON `config` (the fixed limits, mirroring `tenants.toml`). `debug` installs
   * the tracing→console bridge so `[BL:*]` logs show in DevTools. `now_ms` seeds the monotonic clock
   * (`performance.now()`); the playtime stamp comes from `wall_ms` (`Date.now()`).
   */
  constructor(seed: number, config: string, now_ms: number, wall_ms: number, debug: boolean);
  /**
   * Advance the simulation one tick. `now_ms`/`wall_ms` feed the monotonic + wall clocks; `dt` is the
   * seconds since the last tick. Returns whether the room is still open (offline keeps it open).
   */
  tick(now_ms: number, wall_ms: number, dt: number): boolean;
  /**
   * Feed one client input (a JSON `ClientMsg`, the exact wire shape the web client already speaks) for
   * the given player. `now_ms` advances the monotonic clock first, so the room timestamps it correctly.
   */
  input(player_id: number, msg: string, now_ms: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_outboundmessage_free: (a: number, b: number) => void;
  readonly __wbg_wasmcore_free: (a: number, b: number) => void;
  readonly outboundmessage_binary: (a: number) => any;
  readonly outboundmessage_json: (a: number) => [number, number];
  readonly outboundmessage_kind: (a: number) => number;
  readonly wasmcore_add_local_player: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly wasmcore_chunk_edits: (a: number, b: number, c: number) => [number, number];
  readonly wasmcore_drain_outbound: (a: number) => [number, number];
  readonly wasmcore_input: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly wasmcore_new: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
  readonly wasmcore_tick: (a: number, b: number, c: number, d: number) => number;
  readonly wasmcore_world_blob: (a: number) => any;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_drop_slice: (a: number, b: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
