// The offline-via-core flag: OFF by default (the TS offline engine runs exactly as today). Turned on with
// `?wasmoffline=1` in the URL or `localStorage['bl-wasm-offline'] = '1'`, mirroring the `?debug` gate in
// log.ts. When on, the offline path drives the wasm `WasmCore` and renders from its `ServerMsg` stream.

export const WASM_OFFLINE_PARAM = 'wasmoffline';
export const WASM_OFFLINE_STORAGE_KEY = 'bl-wasm-offline';

export function wasmOfflineEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get(WASM_OFFLINE_PARAM) === '1') return true;
    return window.localStorage.getItem(WASM_OFFLINE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
