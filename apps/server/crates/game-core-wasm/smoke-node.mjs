// Node smoke test for the generated WASM offline core: instantiate `WasmCore`, add a player, tick a few
// frames, drain, and assert the seam produced a Welcome + per-tick binary snapshots. Run after building
// the bindings (build-wasm.sh) with: `node apps/server/crates/game-core-wasm/smoke-node.mjs`.
// `--target web` bindings expect a browser; we polyfill the tiny bits Node lacks and `initSync` the bytes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(here, '../../../web/lib/wasm');

const mod = await import(resolve(wasmDir, 'game_core_wasm.js'));
const { default: init, WasmCore, OutboundKind } = mod;

const bytes = readFileSync(resolve(wasmDir, 'game_core_wasm_bg.wasm'));
await init({ module_or_path: bytes });

const config = JSON.stringify({
  tenant: 'demo',
  world: 'main',
  brand_name: 'Demo',
  brand_image: '',
  tick_hz: 20,
  max_players: 10,
  idle_secs: 45,
  edit_reach: 9.0,
  max_speed: 18.0,
  move_per_sec: 40.0,
  edit_per_sec: 25.0,
  chat_per_sec: 2.0,
});

let t = 1000;
const core = new WasmCore(42, config, t, Date.now(), true);
const look = JSON.stringify({ skin: '#f2c18b', shirt: '#ff5d2e', hair: '#3a2a1a' });
const id = core.add_local_player('', look);
if (id !== 1) throw new Error(`expected player id 1, got ${id}`);

const join = core.drain_outbound();
const first = join[0];
if (!first || first.kind !== OutboundKind.Json) throw new Error('first join message must be JSON');
const welcome = JSON.parse(first.json);
if (welcome.t !== 'welcome' || welcome.you !== id) {
  throw new Error(`expected Welcome for player ${id}, got ${first.json}`);
}
if (!welcome.admin) throw new Error('the single offline player must be admitted as admin');

let snapshots = 0;
for (let frame = 0; frame < 5; frame++) {
  t += 1000 / 20;
  core.tick(t, Date.now(), 1 / 20);
  for (const m of core.drain_outbound()) {
    if (m.kind === OutboundKind.Binary && m.binary.length > 0) snapshots++;
  }
}
if (snapshots < 1) throw new Error(`ticking must emit binary snapshots, got ${snapshots}`);

// A build edit flows through as an Edit ServerMsg (proves input → world → outbound end to end). Place
// it right next to the player's spawn so it is within edit reach (the spawn is random per seed).
const [sx, sy, sz] = welcome.spawn;
const editCell = {
  t: 'edit',
  op: 'place',
  x: Math.round(sx),
  y: Math.round(sy),
  z: Math.round(sz),
  id: 3,
};
core.input(id, JSON.stringify(editCell), (t += 5));
const editMsgs = core
  .drain_outbound()
  .filter((m) => m.kind === OutboundKind.Json)
  .map((m) => JSON.parse(m.json));
const edit = editMsgs.find((m) => m.t === 'edit');
if (!edit) throw new Error('an Edit input must produce an Edit outbound');

const blobLen = core.world_blob().length;
if (blobLen <= 0) throw new Error('world_blob must encode the placed edit');

console.log(
  `SMOKE OK: welcome(you=${id}, admin=${welcome.admin}), snapshots=${snapshots}, edit_broadcast=yes, world_blob_bytes=${blobLen}`,
);
