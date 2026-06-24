// Ambient declaration for the gitignored wasm-bindgen artifact (`lib/wasm/game_core_wasm.js`, built by
// `npm run build:wasm`). It lets `tsc --noEmit` pass in CI where the artifact is absent; the bundler
// resolves the real module at build time. The precise typed surface lives in `wasm-core-loader.ts`.
declare module '*/wasm/game_core_wasm.js' {
  const init: () => Promise<unknown>;
  export default init;
  export const WasmCore: unknown;
  export const SnapshotDecoder: unknown;
  export const OutboundMessage: unknown;
  export const OutboundKind: unknown;
  export function worldgen_chunk(cx: number, cz: number): Uint8Array;
}
