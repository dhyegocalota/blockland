// TEST-ONLY: load the committed wasm bundle in Node (vitest) and hand back a factory that builds the real
// `SnapshotDecoder`. The wasm-bindgen `--target web` artifact also runs under Node when its module bytes
// are fed straight to `initSync` (no fetch). Lets the net/offline-core tests decode binary frames through
// the SAME Rust codec production uses, instead of a hand-rolled fake. Memoized so every test shares one
// inited module.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EncodeClientMsg, WasmSnapshotDecoder } from './wasm-core-loader';

interface TestWasmModule {
  SnapshotDecoder: new () => WasmSnapshotDecoder;
  encode_client_msg: EncodeClientMsg;
}

let modulePromise: Promise<TestWasmModule> | null = null;

async function loadModule(): Promise<TestWasmModule> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const wasm = await import('../../wasm/game_core_wasm.js');
    const bytes = readFileSync(fileURLToPath(new URL('../../wasm/game_core_wasm_bg.wasm', import.meta.url)));
    wasm.initSync({ module: bytes });
    return wasm as unknown as TestWasmModule;
  })();
  return modulePromise;
}

// A `decoderFactory`/`createDecoder` drop-in (matches the production signature) backed by the real wasm.
export async function createTestSnapshotDecoder(): Promise<WasmSnapshotDecoder> {
  const mod = await loadModule();
  return new mod.SnapshotDecoder();
}

// An `encoderFactory`/`createEncoder` drop-in (matches the production signature) backed by the real wasm,
// so the send-path + protocol tests encode `ClientMsg` through the SAME Rust codec the server decodes.
export async function createTestClientEncoder(): Promise<EncodeClientMsg> {
  const mod = await loadModule();
  return (json) => mod.encode_client_msg(json);
}
