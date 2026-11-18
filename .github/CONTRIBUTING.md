# Contributing to Blockland

Thank you for helping. Blockland is small and moves fast, so a short conversation first saves everyone time.

## Before you write code

- **Bugs:** open an issue with the bug template: what you did, what you expected, what happened.
- **Features and larger changes:** open an issue first and describe the problem, not only the solution. A change that touches the `game-core` simulation, the wire protocol or the persistence format needs agreement before code.
- **Security issues:** never in a public issue; follow [SECURITY.md](SECURITY.md).

## How work happens here

- **Conventions** are in [CLAUDE.md](../CLAUDE.md): en-US code and docs, user-facing text through the i18n layer, three.js only in `lib/engine/rendering/`, pure `Vec3` in game logic, TypeScript strict, no `?? default` that hides a missing value.
- **Tests are mandatory.** Every new or changed behavior ships with its test in the same change, colocated next to the code (`worldgen.ts` → `worldgen.test.ts`; Rust in an in-file `#[cfg(test)] mod tests`). Unit tests use Vitest and `cargo test`; end-to-end tests use Playwright.
- **The local gate** mirrors CI. Run it before you push:
  - web: `cd apps/web && npm test && npm run build`
  - server: `cd apps/server && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test`
- **Commits** are in English, short and in the imperative mood. Never skip the git hooks.

[Running it](../README.md#running-it) in the README starts the web client and the multiplayer server locally.

## Licensing of contributions

The repository is under the [MIT License](../LICENSE). By submitting a contribution you agree that it is licensed under the same terms.
