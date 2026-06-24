// TEST-ONLY: load the committed wasm bundle in Node (vitest) and hand back a factory that builds the real
// `SnapshotDecoder`. The wasm-bindgen `--target web` artifact also runs under Node when its module bytes
// are fed straight to `initSync` (no fetch). Lets the net/offline-core tests decode binary frames through
// the SAME Rust codec production uses, instead of a hand-rolled fake. Memoized so every test shares one
// inited module.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WasmSnapshotDecoder } from './wasm-core-loader';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modulePromise: Promise<any> | null = null;

async function loadModule(): Promise<{ SnapshotDecoder: new () => WasmSnapshotDecoder }> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const wasm = await import('../../wasm/game_core_wasm.js');
    const bytes = readFileSync(fileURLToPath(new URL('../../wasm/game_core_wasm_bg.wasm', import.meta.url)));
    wasm.initSync({ module: bytes });
    return wasm;
  })();
  return modulePromise;
}

// A `decoderFactory`/`createDecoder` drop-in (matches the production signature) backed by the real wasm.
export async function createTestSnapshotDecoder(): Promise<WasmSnapshotDecoder> {
  const mod = await loadModule();
  return new mod.SnapshotDecoder();
}
