# E2E: coop reconnect

`reconnect.spec.ts` proves the internet-drop → auto-reconnect flow is coherent for BOTH the dropped
player and the others, against a real stack (authoritative Rust server + this Next app pointed at it).

## What it checks

- Two players (two browser contexts) in the same world each see the other in the presence roster.
- Dropping player A (`context.setOffline(true)`) shows A a friendly **reconnecting** overlay (the
  `#connectingOverlay` look, not the severe `#kickOverlay`), while B **still sees A** during the server
  grace — no instant "left".
- Restoring A (`context.setOffline(false)`) returns A to **online** (overlay clears) and B keeps seeing
  A resumed — no permanent leave.

This mirrors the server's reconnect grace + resume (`apps/server/.../room.rs`, `RECONNECT_GRACE = 8s`):
a dropped slot is held (avatar frozen, marked `away` in the roster) and a rejoin with the same identity
resumes the same player id/position/score/inventory.

## Booting the stack

The spec needs the web app reachable (default `http://localhost:3000`) with
`NEXT_PUBLIC_SERVER_URL` set to the running server's WebSocket endpoint.

1. **Start the Rust server** (from `apps/server`):

   ```bash
   cd apps/server
   cargo run            # listens on :8080 by default, WS at /ws
   ```

   (CI builds it in `rust:1-slim-bookworm`; locally you need the Rust toolchain + the libsql native
   build deps `pkg-config libssl-dev clang`.)

2. **Start the Next app pointed at it** (from `apps/web`, a second terminal):

   ```bash
   cd apps/web
   NEXT_PUBLIC_SERVER_URL=ws://localhost:8080/ws npm run dev
   ```

3. **Run the e2e** (a third terminal):

   ```bash
   cd apps/web
   npx playwright install chromium   # once, to fetch the browser
   npm run e2e
   ```

Override the web origin with `E2E_BASE_URL` (e.g. against a deployed preview).

## Notes

- The reconnect grace is 8s server-side; the spec drops and restores A well inside that window so the
  **resume** path (not a fresh join) is exercised.
- `vitest` excludes `e2e/**` and only picks up `*.test.ts(x)`; this spec is `*.spec.ts`, so the two
  suites never collide.
