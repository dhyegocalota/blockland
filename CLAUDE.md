# Blocklandia — project rules

White-label platform of 3D voxel worlds for kids. Monorepo: `apps/web` (Next.js + TypeScript
game client, `/admin`, libSQL tenant store) and `apps/server` (Rust authoritative multiplayer).

## Hard rules

- **en-US only.** All code, identifiers, comments, commit messages, logs and docs are en-US.
  User-facing text goes through the i18n layer (`apps/web/lib/i18n`, **pt-BR is the default**
  display locale, en-US available). Tenant content (name/tagline/etc.) is data, not code.
- **Tests for absolutely everything, especially game logic.** Unit-test every pure module;
  cover the rendering/glue with e2e.
- **Colocate tests next to the implementation:** `worldgen.ts` → `worldgen.test.ts` in the same
  folder. Never a separate `test/`/`__tests__/` dir. (Rust uses `#[cfg(test)] mod tests` in-file.)
- **Keep the game engine small and modular.** Pure logic (worldgen, world store, physics,
  raycast, blocks, structures, creatures) lives in small `apps/web/lib/engine/*.ts` modules with
  colocated tests; only thin Three.js/DOM glue stays untyped-by-necessity.
- **TypeScript strict** in `apps/web`. No blanket `any` on public surfaces.
- **No silent `?? default` fallbacks** that mask missing state (see global `~/.claude/CLAUDE.md`).
- **CI must stay green:** web (`tsc --noEmit`, `npm run build`, `vitest`) and Rust
  (`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`).

## Debug logging

- Browser: `apps/web/lib/log.ts` — `debug/warn/error(scope, msg, fields)`, tagged `[BL:<scope>]`,
  gated by `?debug=1` or `localStorage.bl-debug='1'`. Log useful fields (ids, counts, coords,
  durations, reasons).
- Server: `tracing` with `RUST_LOG=info,server=debug`; structured `key = value` fields, short en-US messages.

## Server model

One persistent world per tenant (`world = "main"`); limits are fixed and global (`tenants.toml`
is branding only). World edits persist as a compressed diff (`sim::encode_edits`, delta-varint +
LZ4) flushed every ~10s when dirty and on room close; restored on room open.
