# 🧱 Blockland

A **white-label** platform of 3D voxel worlds for kids: explore an endless block world, build
and dig, hunt creatures, fight monsters, collect stars, fly, and play together. Each customer
is a **tenant** with its own branding (name, colors, avatar, photo-on-a-block). The sample
tenant shipped with the repo is **Acme**.

The interface defaults to **pt-BR** (en-US is also available) through an i18n layer, while each
tenant's content (name, tagline, face image, brand color) is stored as data — never baked into
the engine.

The defining property of the codebase: **the authoritative game simulation is one Rust crate
(`game-core`) that runs natively inside the multiplayer server for online play AND compiles to
WASM in the browser for offline single-player.** The Rust↔TS gameplay duplication has been
**eliminated**: the same Rust `Room` owns the world, creatures, combat, hearts, scores and admin
state in both modes; worldgen, the snapshot codec, the shared constants and block ids all have a
**single Rust source** the client consumes (generated or via WASM). What remains on the client is
only **prediction and rendering** — never gameplay logic (see [the unification section](#the-game-core--wasm-unification)).

---

## Table of contents

- [What the game does](#what-the-game-does)
- [Architecture at a glance](#architecture-at-a-glance)
- [The game-core / WASM unification](#the-game-core--wasm-unification)
- [Single Rust source: what the client no longer duplicates](#single-rust-source-what-the-client-no-longer-duplicates)
- [Monorepo layout](#monorepo-layout)
- [Client bundle & loading](#client-bundle--loading)
- [Web client engine](#web-client-engine)
- [Rendering subsystem](#rendering-subsystem)
- [Multiplayer & snapshot optimization](#multiplayer--snapshot-optimization)
- [World & persistence](#world--persistence)
- [Creatures, combat & economy](#creatures-combat--economy)
- [Admin, moderation, white-label & i18n](#admin-moderation-white-label--i18n)
- [Running it](#running-it)
- [Environment variables](#environment-variables)
- [Build, test, deploy & CI](#build-test-deploy--ci)

---

## What the game does

- **Endless explorable voxel world** — procedurally generated terrain across 8 biomes (ocean,
  beach, plains, forest, desert, savanna, mountains, snow), with water bodies, beaches,
  snowcapped peaks, biome-tinted trees and scattered plants. A central tenant **welcome
  monument** (a 2-tall tenant face on a gold cross) sits at world center. The world streams in
  around the player, so it feels boundless.
- **First-person movement** — WASD/arrows + mouse-look on desktop, on-screen joystick + buttons
  on touch; jump, gravity, fly mode, ground-snap, void-fall respawn.
- **Build / break / dig** — 19 block types with hand-painted pixel textures (including a
  tenant-face block, diamond, gold, rainbow, and a cosmic "avaritia" block); crosshair
  place/break, dig progress, colored break "poofs", inventory banking + hotbar counts, and an
  infinite-resource sandbox toggle.
- **Magic structures** — one-click stamps (trophy, ball, …) from a build menu; admins can block
  specific structure kinds.
- **Creatures** — pigs, chickens, cows (peaceful), slimes and spiders (hostile) that wander,
  chase, orbit and flee. Hit them for stars; monsters bite the player (red flash + hearts);
  defeated creatures drop hearts that heal.
- **Co-op multiplayer** — remote players with custom looks (skin/shirt/hair), chat, a live
  roster/scoreboard, a kill feed, and optional PvP. Scores and the record are
  server-authoritative.
- **Lobby + passwordless auth** — Solo ("Sozinho") / Online ("Com amigos") toggle; email magic
  link or 6-digit code claims a player name; guests can play too.
- **Admin / moderation** — an in-game and a headless lobby admin panel with the same command set:
  peace, PvP, chat, approval gating, kick/ban, world reset, score reset, suspend, playtime
  limits, and online/offline mode gates.
- **Settings menu** — audio (master volume + mute) and look sensitivity (separate mouse + touch),
  opened by Esc (pointer-lock pause) or a ⚙ gear and persisted per-device in `localStorage`; desktop
  HUD buttons show their keyboard shortcut as a small **key-cap** badge (hidden on touch).
- **Debug HUD (F3)** — live snapshot plus a copyable plaintext report.

Online (native server) and offline (in-browser WASM) behave **identically** because both drive
the same authoritative Rust `Room`.

---

## Architecture at a glance

```
                          ┌──────────────────────────────────────────────┐
                          │            game-core  (pure Rust)             │
                          │  authoritative Room: worldgen, world edits,   │
                          │  creatures, combat, hearts, scores, admin,    │
                          │  AOI snapshot codec, chat moderation          │
                          │  depends on: sim, protocol  (no I/O)          │
                          │  seams: OutboundSink · Persistence · RoomHost │
                          │         time::Instant · injected StdRng       │
                          └───────────────┬───────────────┬──────────────┘
                            compiled NATIVE │               │ compiled to WASM
                                            ▼               ▼
            ┌───────────────────────────────────┐   ┌──────────────────────────────────┐
            │  apps/server  (Rust I/O shell)     │   │ game-core-wasm  (#[wasm_bindgen])│
            │  axum WS/HTTP · tokio · libSQL     │   │  WasmCore: input/tick/drain      │
            │  Hub · room actor · admit policy   │   │  WasmSink/NoPersistence/WasmHost │
            │  HMAC · bans · claims · storage    │   │  JS clock + JS-seeded RNG        │
            └──────────────┬────────────────────┘   └─────────────────┬────────────────┘
                           │ WebSocket  up: all-binary ClientMsg       │ in-process
                           │  down: binary snapshot + JSON ServerMsg   │
                           ▼                                           ▼
            ┌───────────────────────────────────────────────────────────────────────────┐
            │  apps/web  (Next.js + TS) — one NetClient interface, two sources           │
            │  net.ts (WebSocket)  ▲  wasm-core-source.ts (WASM)   ← identical routing    │
            │  coop.ts diff/interp · engine/* pure logic (Vec3) · rendering/* (three.js)  │
            └───────────────────────────────────────────────────────────────────────────┘
```

Three load-bearing invariants:

1. **One authoritative sim, two targets.** `game-core` is I/O-free; everything host-specific is
   behind three injected traits (`OutboundSink`, `Persistence`, `RoomHost`), a clock abstraction
   (`time::Instant`), and an injected `StdRng`. The native server and the browser are both thin
   shells around the same `Room`.
2. **One `NetClient` interface, two sources.** The browser talks to either a WebSocket
   (`net.ts`) or the in-process WASM core (`wasm-core-source.ts`) through the *same* interface;
   the renderer, HUD and admin panel are mode-agnostic.
3. **three.js confined to `rendering/`.** No other engine module imports `three`; logic uses the
   pure `Vec3` and gets three handle *types* via `rendering/gfx.ts`. Positions live in state;
   `rendering/` syncs meshes from them.

---

## The game-core / WASM unification

The authoritative room simulation was extracted from the native server into a pure Rust crate
(`game-core`) that compiles to **two targets** — native (server, online) and **WASM** (browser,
offline). Both targets drive the same `Room::tick`, so single-player and co-op run identical
logic with zero gameplay duplication.

**Injected seams (`game-core/src/{conn,persistence,host,time}.rs`):**

| Seam | Native | WASM (offline) |
| --- | --- | --- |
| `OutboundSink` | tokio `mpsc` | `Rc<RefCell<VecDeque>>` (`WasmSink`) |
| `Persistence` | real libSQL writes | `NoPersistence` (no-ops) |
| `RoomHost` | wraps `Arc<Hub>` (ids, bans, claims, telemetry, config writes) | `WasmHost` (counter ids, no bans, local player is its own claim holder, config no-ops) |
| `time::Instant` | re-export of `std::time::Instant`/`SystemTime` | `u64`-millis newtype reading JS `performance.now()` / `Date.now()`, saturating subtraction |
| RNG | `StdRng::from_entropy` | `room.reseed(seed)` with a JS-provided u32 → deterministic spawns |

The room reads `crate::time::Instant` and never calls `Instant::now()` itself — the I/O shell
reads the clock **once per tick/event** and feeds it in. This is the seam the WASM core needs.

**WASM surface (`game-core-wasm/src/wasm_api.rs`):** a `#[wasm_bindgen]` `WasmCore` —
`new(seed, configJson, now, wall, debug)` → `add_local_player(name, lookJson)` (admitted as
**Admin**, parity with the web offline-admin grant) → `input(playerId, clientMsgBytes, now)` (the
**binary `ClientMsg`** via `decode_client_msg`, the same codec the WebSocket client encodes with) →
`tick(now, wall, dt)` → `drain_outbound()` yielding `OutboundMessage{kind: Json|Binary}` (binary
snapshots + JSON for the rest, exactly like the wire). Plus the standalone `worldgen_chunk(cx,cz)`,
the `SnapshotDecoder`, the binary `encode_client_msg`, `chunk_edits(cx,cz)` and `world_blob()`.
Inputs/outputs are the **exact wire `ClientMsg`/`ServerMsg` shapes** the WebSocket client already
speaks. A `log_bridge` maps `tracing` events to `console.{debug,warn,error}` as `[BL:<scope>]`,
matching the web logger.

The only `#[cfg]` forks in the hot path are `time` (clock), `broadcast_snapshot` (rayon vs
`iter_mut`), and the wasm-only API/log/bindings modules. Everything else is shared.

---

## Single Rust source: what the client no longer duplicates

The client used to hand-mirror server logic in TypeScript; that duplication is now gone. Each
former mirror has a **single Rust source** the client consumes — generated at build time or called
through the WASM core:

- **Shared constants** (world dims, dig hits, hearts, hurt cooldown, spawn geometry, creature
  tuning) are **generated from Rust** into `apps/web/lib/engine/constants.gen.ts` by a committed
  `#[cfg(test)]` exporter in `game-core/src/web_constants.rs` (the same codegen idea as
  `protocol.gen.ts`). A `committed_web_constants_are_up_to_date` test fails CI if the committed file
  drifts. The old hand-mirrored "Mirrors the Rust" literals are gone.
- **Block ids** (`AIR`/`GRASS`/`DIRT`/…) come from the **same generator** → `constants.gen.ts`, with
  `sim` as the single source. Only client-only palette colours (no server meaning) and naming
  aliases stay hand-written in `constants.ts`.
- **Worldgen.** `apps/web/lib/engine/worldgen.ts` is **deleted**. The TS voxel store
  (`engine/world.ts`) sources each chunk's procedural base — terrain, water, monument, decoration —
  from `sim::worldgen_chunk` via the WASM (`game-core-wasm`'s standalone `worldgen_chunk(cx,cz)`),
  generated **once per chunk on first load and cached** in the in-memory voxel array. Every hot
  per-voxel read (physics, raycast, meshing) hits that cache — **no per-frame WASM**. A
  `worldgen-parity` test pins the WASM base against the cached store.
- **Snapshot codec.** `apps/web/lib/snapshot-codec.ts` and `snapshot-delta.ts` are **deleted**. The
  client decodes snapshots through the WASM `SnapshotDecoder` (the single Rust
  `protocol::snapshot_codec` + its `SnapshotReconstructor`), which keyframes/deltas internally and
  hands JS a packed `Float64Array`; `engine/online/wasm-snapshot-decoder.ts` is the thin seam that
  unpacks it (dividing centimetre integers back to f64) into the named `SnapshotMsg`. Cross-language
  hex fixtures pin the bytes.
- **The offline sim** (creature AI / combat / spawn population, formerly TS) runs in the WASM
  game-core. The last dead leftovers — `engine/offline/creature-separation.ts` and `heart-drop.ts`'s
  pickup/heal rule — were removed too (`heart-drop.ts` now only holds the render-side bob).

**What remains on the client (prediction + rendering, not gameplay):**

- `engine/dig-progress.ts` — the dig-tap UX (local progress so a tap feels instant; the dig itself
  is server-authoritative).
- `engine/spawn-slot.ts` — the client's spawn-column pick (mirrors the Rust ring search so the camera
  starts in a sane place before the first snapshot).
- `engine/offline/creatures.ts` + `lib/net-snapshot.ts`'s creature **kind/def table** — the client
  needs creature names/sizes/colours and the `kind_index → slug` mapping to **render** snapshots.

These are client concerns (prediction + rendering); none of them decide gameplay outcomes.

---

## Monorepo layout

```
apps/
  web/                       Next.js 14 (App Router) + TS strict + three.js 0.160
    app/                     game page, /admin console, /claim, /api/*
    components/Game.tsx       markup-only game shell (#adminPanel)
    components/LobbyAdmin.tsx  headless lobby admin panel
    hooks/use-game.ts          all React state/effects, CoopBridge, lobby/login lifecycle
    lib/game-engine.ts         public surface + one-line boot
    lib/engine/                pure logic + rendering/ (three.js) + online/ + offline/
    lib/coop.ts net.ts protocol.gen.ts net-snapshot.ts  netcode (binary up + down)
    lib/wasm/                 COMMITTED wasm-bindgen artifacts (.wasm + JS bindings + .d.ts)
    lib/i18n/                 flat dotted-key catalog (pt-BR default, en-US)
  server/                    Cargo workspace (resolver 2, release: lto thin, panic=abort)
    crates/
      protocol/              wire enums (serde) + ts-rs codegen + client_codec + snapshot_codec
      sim/                   pure worldgen/voxel/decoration/spawn + edit codec (LZ4)
      game-core/             authoritative Room (native + WASM); rayon off-wasm only
      game-core-wasm/        cdylib+rlib WASM shell (#[wasm_bindgen])
      server/                axum 0.8 WS, tokio, libSQL, HMAC, R2/local storage
    tenants.toml             fixed global server limits (branding lives in libSQL)
    loadtest/                1000-bot wire-cost harness (Node, ws-only)
```

---

## Client bundle & loading

The landing page and lobby stay **light**: three.js, the entire `lib/engine/*`, and the
**~640KB WASM core** are **code-split out** of the initial bundle. The lobby route (`/`) ships a
**~199 kB First Load JS** — none of the engine or wasm is in it.

When the player commits to **Play**, `useGame()` dynamic-imports `lib/game-engine` (the engine
chunk) and inits the wasm core, all behind an **on-brand loading screen** (`components/GameLoader.tsx`
driven by the pure `lib/engine/loader-state.ts` reducer: `idle → loading(engine) → loading(world)
→ ready | error`). The loader mirrors the lobby's sky/cloud/hill visual language so it reads as part
of the game, not a generic spinner, and swaps to a retry message on failure rather than a blank
screen. Net effect: the landing/lobby experience loads fast on any device, and the heavy 3D payload
only arrives the moment it's actually needed.

---

## Web client engine

`apps/web/lib/engine/` + `lib/game-engine.ts` + `hooks/use-game.ts` + `components/Game.tsx`. A
streamed, sparse-voxel 3D engine that boots a Three.js scene per tenant and runs identically
online and offline. The engine has **no gameplay authority of its own** — the core (native or
WASM) owns world edits, creatures, hearts and admin state in both modes.

**Boot & composition root.** `Game.tsx` is markup-only; `useGame()` owns all React state and
effects. Once the tenant brand resolves and the HUD DOM exists, it dynamic-imports
`lib/game-engine.ts` and calls a one-liner fluent builder:
`GameEngine.builder().forTenant(brand).withBridge(bridge).online().build()`.
`GameEngineBuilder.build()` (`engine/game-engine-builder.ts`) is the **single wirer** — modules
never import the composition root, keeping the dependency arrow one-way (builder → modules). It
creates the `VoxelWorld`, the Three.js scene, the chunk-mesher/poof/heart-drop/view runtimes, the
`EngineState`, computes the spawn slot, assembles one `GameRuntime`, then calls
`createHud/createActions/createCreatureView/createCreatureTargeting/createCoopWiring/createGameLoop`
and returns a `cleanup` closure (disposes renderer, closes coop, aborts listeners, saves
position).

**Dependency inversion — the `GameRuntime`.** Two shared "world-of-references" objects:
`EngineContext` (the minimal three.js glue the mesher needs) and `GameRuntime` (tenant/boot info,
three handles, the voxel world, all runtimes, `EngineState`, and ~70 **function fields** filled
by each module's `createX(runtime)` factory). Fields are **late-bound by design** — a module may
read `runtime.spawnPoof` before the module that assigns it has run, because calls happen at game
time. This lets each concern live in its own small module while still calling across boundaries
(break → poof → stats) exactly as one closure would.

**Pure modules (each colocated with a `*.test.ts`):** `vec3`, `world`, `blocks`,
`meshing`, `raycast`, `sphere-cast`, `physics`, `movement`, `structures`, `chunk-grid`,
`mesh-queue`, `actors`, `attack`, `frame-cap`, `spawn-slot`, `terrain-column`, `inventory`,
`scoreboard`, `interpolation`.

- **`vec3.ts`** — a three.js-free vector that is a **verbatim port** of the `THREE.Vector3`
  methods used, each body matching three.js IEEE-754 semantics exactly (golden-proved in
  `vec3.test.ts`, the sole logic file allowed to import three).
- **`world.ts`** — the sparse voxel store. There is no TS worldgen anymore: each chunk's procedural
  base is sourced from `sim::worldgen_chunk` via the WASM (the single Rust source), generated once on
  first load and cached, then every hot per-voxel read hits the in-memory cache (no per-frame WASM).
  `worldgen-parity.test.ts` pins the WASM base against the cached store.
- **`physics.ts`** — AABB-vs-voxel collision with per-axis sub-stepping (`MAX_STEP = 0.4`) so a
  fast fall can't tunnel through ground; ground-snap on downward-Y collision.
- **`raycast.ts` / `sphere-cast.ts`** — DDA voxel traversal for break/place; closest-sphere ray
  pick for creatures + PvP within `REACH`. Camera forward is read off the live camera via
  `runtime.cameraForward()` so the logic stays three.js-free.

`game-loop.ts` orchestrates each frame: build the move vector, apply gravity/jump/fly, block
velocity into actors (you can't walk through remote players/creatures), step X/Z/Y, void-respawn,
clamp to world, hold-to-attack repeat, render the view, and (via a frame cap) send coop moves and
periodically save position.

---

## Rendering subsystem

`apps/web/lib/engine/rendering/` — the Three.js presentation layer, and the **only** place in the
engine allowed to `import ... from 'three'` (the sole exception is `vec3.test.ts`, which imports
three solely to golden-prove `Vec3`). All gameplay logic lives in pure modules / the Rust core;
this layer turns state into GPU meshes and DOM, and is dependency-inverted so logic never reaches
into it.

- **Confinement seam (`gfx.ts`).** Logic modules get three handle *types*
  (`GfxScene`/`GfxMesh`/…) via `import type` re-exports; they hold GPU object references without a
  three dependency.
- **Meshing (`meshing.ts`, pure).** `meshChunkBuckets` is a **face-culled, per-block-type** mesher
  (one quad per *visible* face, bucketed by block id — not greedy quad merge). An opaque block
  emits a face only when its neighbor is air/transparent; a transparent block only when its
  neighbor is air (glass-against-glass interiors culled). `getVoxel` reads one cell past the chunk
  bounds for correct seam culling. The glue (`chunk-mesher.ts`) turns each bucket into one indexed
  `BufferGeometry`/`Mesh` per block id sharing that block's prebuilt material.
- **Chunk streaming.** World bounds `SIZE_X=SIZE_Z=163840`, `SIZE_Y=48`, `CHUNK=32` mirror the
  Rust `sim` so client and server agree. A budgeted, nearest-first queue meshes chunks within
  `LOAD_R` (4 touch / 6 desktop) at a per-frame budget (1 touch / 2 desktop), re-queues only on
  chunk crossing, guards stale dequeues, evicts beyond a one-ring hysteresis margin, and
  `geometry.dispose()`s on every removal/rebuild. `remeshRegion` rebuilds the chunk range
  overlapping an edit.
- **Per-frame view (`renderers.ts`).** Sets the camera from the player pose, computes look via
  pure trig, applies the first-person hand swing (`sin(progress·π)·peak` ease), and positions/hides
  the aim highlight box.
- **Textures & materials.** Procedural 16×16 canvas textures per block, `NearestFilter` +
  `SRGBColorSpace` for crisp pixel art; one `MeshLambertMaterial` per block (transparent blocks get
  opacity 0.78 + `DoubleSide`). The tenant **FACE block (id 10)** loads the tenant's uploaded image
  async with a cancel guard.
- **Scene (`scene-setup.ts`).** Sky-blue background, fog, FOV-72 camera (far plane 200 touch / 380
  desktop), hemisphere + directional sun, a sun disc, ~70 drifting cloud boxes, the `worldGroup`,
  and the wireframe highlight.
- **Co-op view (`coop-view.ts`).** The data→three boundary for multiplayer: blocky avatars
  (skin/shirt/hair/pants, a 6-material head with the face on the front, a swinging right arm),
  name-label and chat-bubble sprites (`depthTest:false`, auto-disposed after 6 s), cube creatures
  with a drawn smiley that flashes red on hit, and bobbing heart pickups (one shared merged
  geometry + material). Rigorous geometry/material/map disposal throughout.
- **Particles & hearts.** `poofs-runtime.ts` and `heart-drop-runtime.ts` split pure physics
  (`poofs.ts`, `heart-drop.ts`) from the three glue, keyed by id so offline sim and co-op snapshot
  reconciler spawn/move/remove identically.
- **HUD (`hud.ts`).** WebAudio blip/chime, hotbar block swatches, hotkeys, pointer-lock, resize,
  controls/build-menu modals (blocked-structure cards hidden), and full touch controls (look-drag
  with pitch clamp, joystick, hold-to-attack), all gated by the engine abort signal. The damage cue
  is a red screen wash + heart shake + audio thud over `HURT_FLASH_MS=300`. The audio gain and the
  look math read the live **per-device settings** every frame (see below), so a slider move applies
  instantly.
- **Settings menu (`hud.ts` + `lib/settings.ts`).** A pause/settings panel — **master volume +
  mute** and **look sensitivity** (separate mouse and touch multipliers, clamped kid-safe) — opened
  by **Esc** (which drops pointer-lock and pauses) or a **⚙ gear** button, and closed by Esc again or
  tapping the canvas. The pure `lib/settings.ts` store (load/save round-trip, clamps, gain/look
  scaling, `escapeKeyAction`/`shouldOpenOnLockLost`) is unit-tested; React renders the panel and its
  sliders read/write the store, which **persists per-device** in `localStorage` under `bl-settings`.

Adaptive quality branches touch vs desktop for load radius, fog, far plane, antialias and pixel
ratio. All numeric decisions (cull, queue order, eviction, swing ease, poof/heart physics, aim
trig, scoreboard) are **pure, unit-tested** modules; rendering files are the thin three/DOM
wrapper, e2e-covered.

---

## Multiplayer & snapshot optimization

The server is **authoritative for everything**: world edits (place/break/dig), block inventory,
health/hearts, scores, creature spawns/AI/death, heart pickups, and PvP hits. The client only
requests and renders the authoritative result; local flashes/poofs/sounds are cosmetic and the
truth arrives in the next snapshot.

**Transport & lifecycle (`net.ts`).** One WebSocket (`binaryType='arraybuffer'`) with injectable
socket/clock/connectivity/encoder/decoder for deterministic tests. **Upstream is all binary:** every
`ClientMsg` is encoded by the WASM `encode_client_msg` (the shared Rust `protocol::client_codec`) and
sent as a `Message::Binary` frame. **Downstream**, `ArrayBuffer`/`Blob` frames are the binary
per-tick `Snapshot`; `string` frames are the non-hot JSON `ServerMsg` (Welcome/Roster/Chat/…),
dispatched through a flat `t`-switch to typed handlers.
Resilience is layered: browser online/offline events (fastest) → a 5 s silent-message liveness
watchdog (`dropForReconnect` detaches a half-open socket's `onclose`) → exponential backoff
(`min(10s, 500ms·2^attempt)`). `TERMINAL_ERRORS` (banned, kicked, idle_timeout, room_closed,
suspended, time_up, online_blocked, reclaimed, claim_required, needs_login, rejected) stop
reconnect; `needs_approval` re-joins every 3 s until approved; `pagehide` force-closes for a clean
leave. Ping/pong measures live RTT.

**Wire protocol (`protocol` crate).** `ClientMsg`/`ServerMsg` are `serde(tag="t")` enums. The wire is
**binary in both directions for the hot paths**: every `ClientMsg` (all 28 variants — move/edit/hit/
dig/chat + the admin commands) goes through `client_codec` (`encode_client_msg`/`decode_client_msg`,
a 1-byte tag + packed fields), and the per-tick `Snapshot` goes through `snapshot_codec`. The old
JSON-text upstream path (`Message::Text` → `serde_json::from_str::<ClientMsg>`) is **removed**; the
only JSON left on the wire is the **downstream non-hot `ServerMsg`** (Welcome/Roster/Chat/Error/…).
Hot-path snapshot records use fixed-order numeric tuples (`PlayerState`, `CreatureState`,
`HeartDropState`); creature kind is an index into a shared kind table. **Identity
(name/look/role/pvp-kills/away) is split out of the hot path** into an event-driven `roster`, never
re-sent 30×/s. TS types are generated from the Rust types by a ts-rs **test** that writes
`apps/web/lib/protocol.gen.ts`, and **cross-language hex fixtures pin both codecs byte-identical**, so
the client never hand-writes wire shapes.

**Binary snapshot codec (`protocol::snapshot_codec`, single Rust source).** Little-endian frame:
version byte + frame kind (`KEYFRAME`/`DELTA`) + u64 tick. Floats are carried as **i32 centimetres**
(`round(value*100)`); a `DELTA` carries `baseline_tick` + per-category changed/added full records and
removed ids; absent entities are unchanged. Equality compares **at wire precision** so sub-centimetre
wobble never resends an entity. The TS codec is **gone** — the client **decodes through the WASM
`SnapshotDecoder`**, which wraps the same Rust codec + `SnapshotReconstructor` and hands JS a packed
`Float64Array` (centimetre integers, divided back to f64 in `engine/online/wasm-snapshot-decoder.ts`
exactly as the old codec did). The exact keyframe + delta hex is pinned in Rust and re-decoded in the
TS test — server encode and client decode are the **same code**; the version tag makes a layout change
a clean reject.

**Delta reconstruction (`protocol::SnapshotReconstructor`, inside the WASM decoder).** It holds the
running full snapshot: a keyframe replaces it; a delta whose `baseline_tick` matches upserts changed
and drops removed; a stale-baseline delta is dropped (the decoder returns an empty buffer → `net.ts`
waits for the next keyframe). `onSnapshot` always receives the same full-shape object regardless of
what was on the wire.

**Per-player AOI culling (`aoi.rs` + `spatial_grid.rs`).** Each connection gets only the entities
near it. `in_view` is a horizontal squared-distance test (no per-entity `sqrt`) with **hysteresis**
(enter at `AOI_RADIUS=512`, stay until `+AOI_HYSTERESIS`) so boundary entities don't flicker; the
receiver's own record is never culled. A uniform spatial hash keyed by `(cell_x,cell_z)/CELL_SIZE`
(with a compile-time `assert!(CELL_SIZE ≥ AOI_RADIUS+AOI_HYSTERESIS)`) returns the 3×3 cell block —
a true superset of in-range entities — turning per-tick neighbor lookup from O(N²) to
O(neighbors).

**Per-connection keyframe+delta (`game-core/src/room.rs`).** Each connection owns a
`SnapshotBaseline` (its last-sent AOI-filtered view), because AOI makes every player's view
different. A periodic keyframe every `KEYFRAME_INTERVAL_TICKS=60` (~2 s) bounds the baseline; a
join/resume forces a keyframe so a resumed socket never gets a delta against state it never saw.
The candidate set is the grid 3×3 neighborhood **∪ previous-baseline ids** so a drifted sticky
entity is still re-evaluated. The per-tick fan-out runs `rayon::par_iter_mut` over players natively
(disjoint per-connection baselines/channels → **byte-identical to sequential**) and plain `iter_mut`
on WASM, sharing the exact per-receiver encode function.

**Chunked world-edit streaming.** `loaded_chunks` per connection grows as the player moves (never
unloaded — the edit map is sparse, base terrain is procedural). Live `Edit`/`EditBatch` fan out
only to players who have that edit's chunk loaded; a far/away player gets the chunk's *current*
state when they later enter, so they converge and never miss an edit.

**Interpolation/extrapolation (`engine/interpolation.ts`).** Each remote entity renders
`INTERP_DELAY_MS=100` in the past so there's always a straddling pair to lerp (yaw uses
shortest-angle); a late snapshot dead-reckons forward at last velocity up to
`EXTRAPOLATE_MAX_MS=200`, then holds.

**Game glue (`coop.ts`).** Diffs players/creatures/hearts against live maps → spawn/despawn
(+ join/leave feed, creature poof on despawn, heart-collect cue), pushes interpolation samples,
updates self ping/score/health, repaints the HUD, and exposes raycast targets for the crosshair.
It is three.js-free (plain data through the dependency-inverted `CoopView`; meshes live in
`rendering/coop-view.ts`). Targeting only **requests** hits — death/reward/despawn/damage return
authoritatively in the next snapshot. A `DivergenceTracker` warns on client↔server position drift.

**Layered bandwidth wins**, each benchmarked and build-guarded: JSON-full → numeric JSON (~28% of
named-field) → binary keyframe → binary delta (~30% moved) → **delta + AOI (>99% cut on a
1,000-player huge map**, `assert!(reduction > 99.0)`).

---

## World & persistence

`apps/server/crates/sim/` — one pure, deterministic, std-only crate (single `lib.rs`, ~half
tests; one dependency, `lz4_flex`). No I/O, rendering, networking or `rand`. Runs natively
(server) and as WASM (offline) via `game-core`, so one implementation is the source of truth on
both sides.

- **Procedural terrain** is a pure function of coordinates and the **single source** the client now
  consumes via WASM: `height_at` (continent + hills + detail + squared-ridge mountains, all f64);
  `biome_at` (height + temperature/humidity); `base_voxel` (air/water/bedrock/surface/dirt/stone);
  `welcome_monument_block` folded into `base_voxel` so the monument is **real terrain** — solid,
  diggable, visible to creature AI — never a render overlay. `worldgen_chunk` packs a whole chunk's
  base for the client; a TS `worldgen-parity` test (against `worldgen.golden.json`) pins it.
- **Deterministic decoration** uses a `Mulberry32` PRNG seeded by a chunk spatial hash, **bit-for-bit
  identical to the TS `mulberry32`** (JS `Math.imul` == Rust `wrapping_mul`, pinned by a
  Node-computed test). Trees and plants are placed per-biome density, identical for every player and
  after any reset.
- **`World` runtime.** A sparse `edits: HashMap<(i32,i32,i32), u8>` overlay (only player edits
  stored — base terrain is regenerated, never persisted) over a lazy, interior-mutable
  `Mutex<Decor>` cache, read in order edit → decoration → procedural base. `surface_y`, `is_solid`,
  `edits_in_chunk` (streaming) and `snapshot`/`load_edits` (persistence) round it out.
- **One persistent world per tenant** (`world = "main"`): the world is stored as a **sparse diff**
  — `(x,y,z)` linearized, sorted, delta-varint encoded, then LZ4 (`encode_edits`) — sub-byte per
  edit, microseconds to encode. Builds survive restarts; an admin world reset wipes only the edits
  and regenerates clean terrain. The diff is flushed at most every `PERSIST_SECS=10` when dirty and
  on room close, restored on room open.
- **Spawns** scatter within `SPAWN_AREA_RADIUS` and walk Chebyshev rings in a fixed order
  (mirrored in web `findSpawnSlot`) to the nearest column clear of terrain, monument, builds,
  creatures and other players — nobody materializes inside terrain or on top of someone.

Compile-time invariants guarantee flight always has headroom yet can never leave the playable
column (`assert!(MAX_FLY_Y > MAX_HEIGHT)` / `> SIZE_Y`).

---

## Creatures, combat & economy

All implemented once in the Rust `Room` and shared verbatim between the native server and the WASM
offline client — single-player and co-op run the same simulation; the client only renders
snapshots, aims the crosshair and sends intent.

- **Creature AI (`creatures.rs`, pure, RNG-free).** A per-kind stat table (hp, reward, hostile,
  speed) mirrors the web `CREATURE_DEFS`. Each tick a creature picks the nearest player and, only
  if `hostile && !peace && dist < CHASE_RADIUS(30)`, chases it; within `STOP_DISTANCE(0.65)` it
  **orbits**, strafing tangentially. **Determinism without seeds:** `wander_yaw(id,tick)` and
  `orbit_yaw(...)` are pure functions of `(id,tick)` (even ids circle one way, odd the other,
  reversing every `ORBIT_FLIP_TICKS(80)`), reproducible on server and client with zero stored RNG.
  Creatures climb 1-block steps (`MAX_CLIMB`), ease down ledges at `MAX_FALL_SPEED`, refuse to scale
  walls or clip out of dug pits, and `separate_creatures` pushes coincident bodies apart.
- **Population (`simulate_creatures`).** Target `= players × CREATURES_PER_PLAYER(10)` clamped
  `[MIN 12, MAX 48]`, refilled in batches; `DESPAWN_RADIUS(64)` retain + a hard `cap_creatures`
  (farthest-from-player culled first) keep the O(n²) separation/bite loops bounded. Players held for
  reconnect grace are invisible to creatures.
- **Combat & survival.** Hold-to-attack melee; hitting a creature flashes it (`on_hit` validates
  `MELEE_RANGE(8.0) ≥ client REACH(7)`), killing it awards `kind.reward` stars, drops a heart, emits
  a `kill` feed event and persists the new total. `MAX_HP=3`; only non-buried hostile creatures bite,
  within `HURT_RANGE`/`HURT_VERTICAL_GAP`, on a `HURT_COOLDOWN(1.2 s)`; at 0 hearts you respawn at a
  fresh scattered slot with full health. Defeated creatures drop hearts that heal +1 (collected even
  at full health; `HEART_TTL(20 s)`).
- **Economy / leaderboard.** Kills bank **stars** (score) per kind reward; totals persist per
  account and feed the leaderboard (guests don't persist).
- **PvP (admin toggle).** `on_attack_player` is gated on the `pvp` flag + `MELEE_RANGE`; damage is
  **server-applied** (`target.hp -= 1`), a kill bumps the attacker's `pvp_kills` (shown in the roster
  ranking, never the leaderboard) and respawns the victim.
- **Anti-cheat.** All primary actions (dig/hit/pvp) are throttled to `ATTACK_MIN_INTERVAL(200 ms)`;
  offline neutralizes only the *movement* speed/budget clamp (`1_000_000`) since there's one local
  player.

The creature AI / combat / spawn simulation runs in the WASM `Room`; the client only renders its
snapshots, aims and sends intent. The remaining web TS modules are **prediction + rendering**
helpers, not the simulation: `offline/creatures.ts` and `net-snapshot.ts`'s creature kind/def table
(names/sizes/colours to render), `dig-progress.ts` (dig-tap UX), `spawn-slot.ts` (client spawn pick),
`attack.ts` and `scoreboard.ts` — each pinned to the same shared constants so prediction and server
truth agree. (The dead `creature-separation.ts` and `heart-drop.ts`'s pickup rule were removed once
the offline sim moved into the WASM core.)

---

## Admin, moderation, white-label & i18n

**Two control surfaces, one command set.** An in-game admin panel (`#adminPanel` in `Game.tsx`,
shown only to admins/moderators inside the 3D game) and a headless lobby panel
(`LobbyAdmin.tsx`, over a 3D-less server connection) share a single `RoomAdminApi`
(`engine/api.ts`). The lobby connection adapts a headless `NetClient` into that surface via a pure,
fully unit-tested `lobbyAdminApi()` adapter, so one `useRoomAdmin` dispatch drives both panels
unchanged.

**Controls:** Peace, PvP, Chat, blocked-structure gating, the approval gate (with a live pending
list — approve/reject/ban-pending), roster moderation (kick/ban/role assignment), the banned list +
unban, playtime limits (minutes within a rolling window of hours), online/offline mode gating,
two-step armed world reset and score reset, and suspend/resume. Reports (playtime, chat log) are
admin-only.

**Server is the only authority.** Every admin command is a `ClientMsg::Admin*` handled in `room.rs`
where each handler **re-checks the sender's live role** (`Role { Player, Moderator, Admin }`,
reconstructed from `is_admin`/`is_moderator`); wrong role → silently ignored + debug log. Invariants
are baked into the handlers: staff are unbannable, moderators can't kick admins or toggle chat/roles,
a tenant always keeps ≥1 game mode, and a world reset zeroes scores + hearts + inventories. Each
change persists, broadcasts a new `RoomState`, and pushes an i18n'd feed `Event`.

**Admit policy & accounts.** Passwordless login (magic link or 6-digit code, 15-min single-use TTL),
emailed by the Next app; `(tenant,email)` and `(tenant,name)` unique; a claim token must be the
*live* claim in the in-memory `Claims` map. The ordered admit gate (`room_driver.rs`): full → identity
(guest vs claimed) → reconnect resume → **role-aware ban** (a parent on a shared banned home IP still
moderates; banning staff is refused) → suspended/online-blocked (admins exempt) → approval gate
(one-shot reject; HMAC-signed notify emails admins via Resend + pushes a live `PendingApprovals`) →
playtime budget (admins exempt). Rejection codes map 1:1 to kid-friendly messages — **no silent
fallbacks**.

**Reconnect grace.** A dropped socket (no WebSocket Close) holds the slot for an **8 s grace**; a
rejoin resumes the same id/position/score/hp/inventory with no Left/Join churn. A **sink-id identity
check** ensures a late `Leave` from a socket already replaced by a reconnect can never freeze a live
slot.

**White-label & i18n.** Per-tenant branding (name, image, brand color) is resolved by subdomain or
`?tenant=` (`lib/tenants.ts`), fetched from `/api/tenants/:id`, falling back to the bundled
`/tenant.json` offline — **never a silent hardcoded default** (throws `tenant_unresolved`/
`unavailable`). `tenants.toml` holds only fixed global server limits; all per-tenant runtime admin
state lives in libSQL. The platform `/admin` console (app-root only) does tenant CRUD + image upload,
a live online-player table, the global ban list, the accounts table (grant/revoke admin/moderator),
and a read-only leaderboard — gated by a browser-facing `ADMIN_KEY` (constant-time, fail-closed),
distinct from the server-only `ADMIN_TOKEN` the Next proxy attaches upstream (defense in depth via
HMAC). i18n (`lib/i18n/`) is a flat dotted-key catalog (every key in pt-BR + en-US) resolved from URL
prefix → cookie → DEFAULT (pt-BR), with `{var}` interpolation.

---

## Running it

### Web client

```bash
cd apps/web
npm install
npm run dev     # http://localhost:3000
```

- Pick a tenant with `/?tenant=acme` (or a subdomain like `http://acme.localhost:3000`). Most
  browsers resolve `*.localhost` to loopback automatically.
- Add a customer from the `/admin` console (or seed it as a built-in). Nothing tenant-specific is
  baked into the engine.
- **Offline single-player** ("Sozinho") runs the committed WASM core in-browser — no server needed.

### Multiplayer server (Rust)

```bash
cd apps/server
cargo run -p server        # binds 0.0.0.0:8080 by default
```

The server serves all tenants/worlds from one process: an axum `Router`
(`/healthz`, `/ws`, `/online/{tenant}`, `/admin/*` token-gated, `/internal/*` HMAC-gated) wrapping
the `game-core` `Room`. One room actor per tenant runs a 30 Hz tick with a ~2 Hz status sweep
(ban/reclaim/idle prune, playtime flush, roster + telemetry). World state persists to libSQL (local
file by default, Turso-ready). SIGTERM/Ctrl-C broadcasts a `server_down` feed event, waits 800 ms,
then stops gracefully.

---

## Environment variables

See `.env.sample` for the full list.

**Web (`apps/web`):**

| Variable | Purpose |
| --- | --- |
| `ADMIN_KEY` | Browser-facing secret for the `/admin` console and `/api/admin/*` routes. |
| `ADMIN_TOKEN` | Server-only token the Next proxy attaches upstream (never reaches the client). |
| `DATABASE_URL` | libSQL/Turso URL for the tenant store. Unset → local SQLite file. |
| `DATABASE_AUTH_TOKEN` | Auth token for a remote libSQL/Turso database. |
| `INTERNAL_HMAC_SECRET` | Shared secret for the HMAC-signed Next↔Rust approval-notify channel. |

**Server (`apps/server`):**

| Variable | Purpose |
| --- | --- |
| `BIND` | Address the server binds to (default `0.0.0.0:8080`). |
| `RUST_LOG` | Log filter (e.g. `info,server=debug`). |
| `DATABASE_PATH` | libSQL file path (default `./data/blockland.db`). |
| `TENANTS_FILE` | Path to a `tenants.toml` override (fixed global limits). |
| `MAX_PLAYERS_PER_ROOM`, `MAX_CONNECTIONS_PER_IP` | Capacity overrides (defaults 10 / 6). |
| `WEB_BASE_URL`, `INTERNAL_HMAC_SECRET` | Outbound approval-notify target + shared HMAC secret. |
| `KEYFRAME_GIT_SHA` / `GIT_SHA` | Build SHA override (normally baked from git at compile). |

---

## Build, test, deploy & CI

**Committed generated artifacts.** `protocol.gen.ts`, `engine/constants.gen.ts`, and the entire
`lib/wasm/` (the offline-core `.wasm` + JS bindings + d.ts) are committed to git — "committed like
protocol.gen.ts so the web build needs no Rust toolchain." The web build (and Vercel/CI) therefore
needs no Rust/wasm toolchain. Regenerate on source change:

```bash
cargo test -p protocol                          # rewrites apps/web/lib/protocol.gen.ts
cargo test -p game-core                         # rewrites apps/web/lib/engine/constants.gen.ts
apps/server/crates/game-core-wasm/build-wasm.sh # cargo wasm32 + wasm-bindgen → apps/web/lib/wasm/
```

The wasm-bindgen crate↔CLI version (`=0.2.106`) is pinned in three places (crate, build script,
`Dockerfile.wasm`); a reproducible `Dockerfile.wasm` emits the artifacts to a mounted volume.

**Cross-language safety nets.** Wire shapes can't regress silently: ts-rs generates the client types
from Rust, the gameplay/physics/world constants are generated from the Rust source into
`engine/constants.gen.ts` (a `committed_web_constants_are_up_to_date` test fails CI if the committed
file is stale, so the client can never hand-mirror a server number that drifts), a `snapshot_size`
test asserts the compact snapshot stays small, shared **hex fixtures** pin **both binary codecs**
(`client_codec` upstream + `snapshot_codec` downstream) byte-for-byte across Rust↔TS, and a golden
HMAC vector locks both directions of the Next↔Rust channel. The offline core can't diverge from
online (shared crate + shared `NetClient` routing + same room limits).

**Tests.** Colocated everywhere: TS `*.test.ts(x)` next to each module (vitest, jsdom available; ~68
engine modules each colocate a test), golden tests for worldgen/vec3, Rust `#[cfg(test)] mod tests`
in-file (creatures, aoi, spatial_grid, chat, codec, admit policy, reconnect, HMAC vectors, storage),
a Playwright e2e (`reconnect.spec.ts`, deliberately a `*.spec.ts` glob so vitest never picks it up)
driven through the dev-only `window.__blTest` hook, plus a **native** smoke test driving a real
`Room` through the in-memory WASM seams and a **Node** smoke test against the real generated `.wasm`.

```bash
# web
cd apps/web && npm test        # vitest run
npm run e2e                     # playwright (reconnect)

# rust
cd apps/server
cargo fmt --all --check
cargo clippy --all-targets -D warnings
cargo test
```

**Loadtest.** `apps/server/loadtest/` ramps 1000 ws bots (in batches) that **encode binary input**
(`client-codec.mjs`) and **decode binary snapshots** (`snapshot-decoder.mjs`) — both mirroring the
Rust codecs — to target nearby entities; `SPREAD` toggles whole-map AOI vs the
origin-cluster worst case. It reports avg RX bytes/s/bot, frames/s, p50/p95 and the per-action send
mix — capacity confidence before shipping.

_Result — 1000 bots, one room, 30s steady-state_ (release build, single instance, Apple-Silicon
12-core / 24 GB, all 1000 bots from one machine; `BOTS=1000 DURATION_S=30 SPREAD=1 TENANT=acme`):

| metric | value |
| --- | --- |
| bots connected | **1000 / 1000** (1 connect error, 12 reconnects over the run) |
| snapshot frames decoded | **1.87 M** |
| total RX | **7.56 GB** |
| frames/bot/s (steady state) | **~48** |
| avg RX/bot/s | **~200 KB** (peaks ~447 KB/s early, before AOI culling spreads the bots out) |
| per-bot RX p50 / p95 (cumulative) | **5.2 MB / 24.5 MB** |
| client→server sent | move 407 k · dig 24 k · place 16 k · break 12 k · creature-hit 1.3 k · pvp 965 · chat 5.7 k |

The server held all 1000 concurrent players through a realistic build/dig/hunt/PvP/chat mix on one
instance; per-bot RX stays bounded by AOI culling (it falls as the spread widens). With the
multi-server room-lease (see **Deploy & versioning** below), this scales horizontally — one room per
instance, several instances behind a load balancer — without two instances ever serving the same room.

**Deploy & versioning.** The backend bakes its short git SHA at compile (`build.rs` →
`cargo:rustc-env`), shown as `version` in the debug panel; the web exposes `/api/version` so open
clients detect a newer release and surface a non-dismissable update screen. The two-stage server
`Dockerfile` (rust-slim → debian-slim, dependency-cache layer, bundled `tenants.toml`, `/healthz`
HEALTHCHECK) builds with the repo root as context so it can `COPY .git` and self-stamp — designed for
Dokploy; the web client deploys to Vercel.

**Multi-server.** Several server instances can run behind a load balancer; **two instances never serve
the same room**. Each room (one per tenant, `world = "main"`) is guarded by a DB **room-lease** in the
shared libSQL — `room_leases (tenant, world, owner, heartbeat_ms)`. On a join the instance must
`acquire_room_lease`; the holder renews its heartbeat every 5 s while the room is open and releases it
on close, and a lease unrenewed for 30 s (`LEASE_STALE_MS`, a crashed instance) is takeable. An instance
that doesn't hold the lease rejects the join with `served_elsewhere` (the client retries — a
tenant-affinity LB, e.g. subdomain-hashed, routes the retry to the holder). The owner id is `SERVER_ID`
(else the hostname), **stable across restarts**, so a single instance always re-acquires its own room
and never self-deadlocks. Raise `MAX_PLAYERS_PER_ROOM` / `MAX_CONNECTIONS_PER_IP` per the loadtest above
when stress-testing a single instance. Verified end-to-end with two instances on one DB: A joining
`acme` gets `welcome` (holds the lease) while B joining the same room gets `served_elsewhere`.

Running multiple instances requires a **concurrency-capable shared libSQL** (a remote/replicated
Turso-style db, the same one all instances point at) — a single local SQLite **file** is single-writer
and two processes opening a fresh one race on init (`database is locked`). The lease coordination lives
entirely in that shared db, so a remote libSQL is the multi-server deployment requirement.

**CI (`.github/workflows/ci.yml`, two jobs on push-to-main + every PR):**

- **web** — `npm ci && npm test && npm run build` (Node 20; `next build` covers typecheck).
- **rust** — `cargo fmt --all --check && cargo clippy --all-targets -D warnings && cargo test`.

CI must stay green on both.

---

Made with 💛 — it started as a custom 3D block world for one kid and became a platform.
