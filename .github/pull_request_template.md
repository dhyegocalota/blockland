## Summary

<!-- Two to four sentences: what changed and why. Link the issue it closes. -->

## Screenshots

<!-- One row per user-visible change, before/after when it helps. "No user-visible change" for server-only or refactor PRs. -->

| Before | After |
|---|---|
| ![caption](url) | ![caption](url) |

## Test plan

<!-- The tests added or changed, and how you exercised the change by hand (offline, online, admin). -->

## Not changing

<!-- What a reader might expect here and deliberately is not. -->

## Checklist

- [ ] 🧪 Tests colocated next to the code: unit, and e2e when the glue changed
- [ ] ✅ `npm test && npm run build` (web) and `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (server) pass
- [ ] 🌍 Code in English; user-facing text through `lib/i18n` in pt-BR and en-US
- [ ] 🧱 three.js only in `lib/engine/rendering/`; no `?? default` masking missing state
