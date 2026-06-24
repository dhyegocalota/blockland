//! WASM wrapper around the pure `game-core::Room` for the single-player OFFLINE game: a small
//! `#[wasm_bindgen]` `WasmCore` the browser drives, backed by in-memory (db-free) trait impls so a
//! restart loses everything. This is the seam the TS offline path will call in Stage 3; it changes no
//! existing behavior (the offline game still runs the TS engine today).
//!
//! The pure in-memory backings (`WasmSink`/`NoPersistence`/`WasmHost`) live in `memory` and are plain,
//! native-testable Rust. Only the `#[wasm_bindgen]` shell + the tracing→console bridge below are
//! wasm-only. Time + RNG are injected from JS: the room's clock reads `performance.now()`/`Date.now()`
//! via `game_core::time`, and its `StdRng` is reseeded from a JS-provided seed for determinism.

pub mod memory;

#[cfg(target_arch = "wasm32")]
mod log_bridge;
#[cfg(target_arch = "wasm32")]
mod wasm_api;

#[cfg(target_arch = "wasm32")]
pub use wasm_api::WasmCore;
