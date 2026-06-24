# game-core-wasm

The browser-loadable WASM build of the pure `game-core::Room`, for the **single-player offline** game.
A thin `#[wasm_bindgen]` shell (`WasmCore`) over the same authoritative room the native server runs,
backed by **in-memory, db-free** trait impls so a restart loses everything (offline parity with the old
client). This is **additive** — it changes no existing behavior; the offline game still runs the TS
engine today. Stage 3 switches the offline path over to call this.

## What's inside

- `memory.rs` — the three in-memory host seams (plain, native-testable Rust):
  - `WasmSink` (`OutboundSink`): queues each `Outbound`; the JS loop drains it. Unique id per connection
    (a counter), stable across clones, for the reconnect-grace identity check.
  - `NoPersistence` (`Persistence`): every method is a no-op (no db).
  - `WasmHost` (`RoomHost`): ids from a counter; no bans/claims (the lone local player owns their own
    claim, so kick-on-reclaim never fires); admin-config writes + admin-broadcasts are no-ops.
- `wasm_api.rs` (wasm-only) — the `WasmCore` `#[wasm_bindgen]` surface.
- `log_bridge.rs` (wasm-only) — a `tracing` → `console.{debug,warn,error}` bridge, formatted like the
  web app's `[BL:<scope>]` lines, gated by the `debug` flag passed to `WasmCore::new`.

### Time + RNG on wasm

`game-core` has no `std::time::Instant`/`SystemTime` on wasm. `game_core::time` abstracts the clock: on
native it **is** `std::time::Instant` + `SystemTime` (a plain re-export — zero behavior change); on wasm
it's a millis newtype whose `now()` reads a JS-injected monotonic clock (`performance.now()`) and whose
`epoch_ms()` reads a JS-injected wall clock (`Date.now()`). `WasmCore` threads `now_ms`/`wall_ms` from JS
on every `new`/`input`/`tick`. The room's `StdRng` is reseeded from a JS-provided `seed` for determinism
(native stays `from_entropy`).

## API (the Stage 3 seam)

```ts
const core = new WasmCore(seed, configJson, performance.now(), Date.now(), debug);
const playerId = core.add_local_player(name, lookJson); // the player is the room admin
core.input(playerId, clientMsgJson, performance.now());  // JSON ClientMsg, the wire shape
const open = core.tick(performance.now(), Date.now(), dt);
for (const m of core.drain_outbound()) {                 // Welcome/roster/edits/snapshots
  if (m.kind === OutboundKind.Json) handleServerMsg(JSON.parse(m.json));
  else applySnapshot(m.binary);                           // the compact per-tick blob
}
const edits = core.chunk_edits(cx, cz); // [x,y,z,id, …] built-structure overlay for the renderer
const blob = core.world_blob();         // sim::encode_edits diff of the whole built world
```

`configJson` is `{tenant, world, brand_name, brand_image, tick_hz, max_players, idle_secs, edit_reach,
max_speed, move_per_sec, edit_per_sec, chat_per_sec}` (mirror `apps/server/tenants.toml`). `lookJson` is
`{skin, shirt, hair}`.

## Build

```bash
# one-time: the wasm target + the bindings generator (the Docker image installs both)
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli

# build the .wasm + JS bindings into apps/web/lib/wasm/
./build-wasm.sh           # release (default)
./build-wasm.sh debug     # debug profile
```

Or fully reproducibly via Docker (installs the target + matching `wasm-bindgen-cli`):

```bash
# from the repo root (the build context must be the repo root)
docker build -f apps/server/crates/game-core-wasm/Dockerfile.wasm -t blockland-wasm .
docker run --rm -v "$PWD/apps/web/lib/wasm:/out" blockland-wasm
```

Artifacts land in `apps/web/lib/wasm/` (`game_core_wasm.js`, `game_core_wasm_bg.wasm`, `*.d.ts`). The
heavy `.wasm` + generated JS are gitignored; the wrapper source, `build-wasm.sh`, `Dockerfile.wasm`, and
this README are committed.

## Tests

The `#[wasm_bindgen]` shell is wasm-only and a real browser test needs a browser, so the **smoke test
runs natively**: it drives a REAL `game_core::Room` through the three in-memory impls (add the admin
player, tick, drain) and asserts the seam produced a `Welcome` then per-tick binary snapshots — no db, no
socket, no browser. Plus unit tests for the sink queue/drain/ids, the host, and the no-op persistence.

```bash
cargo test -p game-core-wasm
```

There is also a **Node smoke test of the real generated WASM** (build the bindings first): it instantiates
`WasmCore`, adds the admin player, ticks, drains, and asserts a Welcome + binary snapshots + an Edit
round-trip, and shows the `[BL:*]` console bridge:

```bash
./build-wasm.sh
node smoke-node.mjs
# → SMOKE OK: welcome(you=1, admin=true), snapshots=5, edit_broadcast=yes, world_blob_bytes=13
```
