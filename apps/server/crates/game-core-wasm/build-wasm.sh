#!/usr/bin/env bash
# Build the offline game-core WASM module + JS bindings into apps/web/lib/wasm/.
#
# Requires (the Docker image installs these — see the README): the wasm32 target
# (`rustup target add wasm32-unknown-unknown`) and `wasm-bindgen-cli` (`cargo install wasm-bindgen-cli`).
#
# Output: apps/web/lib/wasm/{game_core_wasm.js, game_core_wasm_bg.wasm, *.d.ts}. The heavy .wasm + the
# generated JS are gitignored (this script regenerates them); the wrapper source + this script + the
# README are committed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${SERVER_DIR}/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/apps/web/lib/wasm"

PROFILE="${1:-release}"
TARGET_DIR="${SERVER_DIR}/target/wasm32-unknown-unknown/${PROFILE}"

echo "building game-core-wasm for wasm32 (${PROFILE})..."
cd "${SERVER_DIR}"
if [ "${PROFILE}" = "release" ]; then
  cargo build -p game-core-wasm --target wasm32-unknown-unknown --release
else
  cargo build -p game-core-wasm --target wasm32-unknown-unknown
fi

echo "generating JS bindings into ${OUT_DIR}..."
mkdir -p "${OUT_DIR}"
wasm-bindgen \
  --target web \
  --out-dir "${OUT_DIR}" \
  --out-name game_core_wasm \
  "${TARGET_DIR}/game_core_wasm.wasm"

echo "done. artifacts in ${OUT_DIR}"
