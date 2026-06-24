// 1000-bot load/stress harness for the Blockland Rust server. Each bot opens a WebSocket, joins as a
// guest, then runs a realistic MIX of actions (run, fly, dig/place, hit a creature, pvp, chat) at the
// server's rate-limit cadence — a worst case for the per-connection AOI snapshot encode and every
// broadcast path. It sends each action as the compact BINARY client frame the web client now sends
// (see client-codec.mjs) and decodes the binary snapshot frames (see snapshot-decoder.mjs) to learn
// which creatures/players are nearby, counting RX bytes/frames to report the real wire cost per bot.
//
// Run: BOTS=1000 DURATION_S=30 URL=ws://localhost:8080/ws TENANT=acme node bots.mjs
// See README.md for running it against the docker server (raise the two server caps via env).

import WebSocket from 'ws';
import { decodeFrame, SnapshotState, nearestWithin } from './snapshot-decoder.mjs';
import { encodeClientMsg } from './client-codec.mjs';

// --- config (env / CLI) ---
const BOTS = intEnv('BOTS', 1000);
const DURATION_S = intEnv('DURATION_S', 30);
const URL = process.env.URL ?? 'ws://localhost:8080/ws';
const TENANT = process.env.TENANT ?? 'acme';
// SPREAD on (default): scatter bots far apart across the giant map so AOI actually culls. Off: cluster
// them near the origin so everyone is in everyone's view (the busy-room worst case for the encode).
const SPREAD = (process.env.SPREAD ?? '1') !== '0';
// Ramp connections in batches so we don't open 1000 sockets in one event-loop turn and hammer the box.
const RAMP_BATCH = intEnv('RAMP_BATCH', 50);
const RAMP_DELAY_MS = intEnv('RAMP_DELAY_MS', 100);

// --- world + cadence constants (mirror the server) ---
const WORLD_SIZE = 163840; // sim::WORLD_SIZE
const GROUND_Y = 64.25; // a typical eye height over the procedural surface
const MOVE_HZ = 18; // ~15-20Hz, within the server's move bucket (d_move = 40/s)
const ACTION_HZ = 3; // dig/hit/place/pvp/chat cadence — a few per second (edit bucket d_edit = 25/s)
const MELEE_REACH = 8; // server MELEE_RANGE — how close a creature must be to Hit it
const EDIT_REACH = 9; // server edit_reach — how close a cell must be to Edit/Dig it
const PVP_REACH = 8; // a nearby player to AttackPlayer
const REPORT_EVERY_MS = 5000;
const PROGRESS_PCT = 100;

// Weighted action mix per action tick (RUN/FLY are continuous via the move loop; these are the discrete
// "do something" picks). Weights are relative; higher = more often.
const ACTIONS = [
  { name: 'dig', weight: 30 },
  { name: 'place', weight: 20 },
  { name: 'break', weight: 15 },
  { name: 'hit', weight: 20 },
  { name: 'pvp', weight: 8 },
  { name: 'chat', weight: 7 },
];
const ACTION_TOTAL_WEIGHT = ACTIONS.reduce((sum, a) => sum + a.weight, 0);

const CHAT_LINES = ['hi', 'gg', 'lol', 'over here', 'help', 'nice build', 'wow'];

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) return fallback;
  return value;
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function pickAction() {
  let roll = Math.random() * ACTION_TOTAL_WEIGHT;
  for (const action of ACTIONS) {
    roll -= action.weight;
    if (roll < 0) return action.name;
  }
  return ACTIONS[ACTIONS.length - 1].name;
}

// Where bot `index` of `total` starts: spread uniformly across the world (so AOI matters) or clustered
// near the origin (so everyone shares a view). A deterministic layout keeps runs comparable.
function homeFor(index, total) {
  if (!SPREAD) {
    const jitter = () => 100 + randomInt(60);
    return { x: WORLD_SIZE / 2 + jitter(), z: WORLD_SIZE / 2 + jitter() };
  }
  const side = Math.ceil(Math.sqrt(total));
  const col = index % side;
  const row = Math.floor(index / side);
  const x = ((col + 0.5) / side) * WORLD_SIZE;
  const z = ((row + 0.5) / side) * WORLD_SIZE;
  return { x, z };
}

// Aggregate metrics across every bot.
const metrics = {
  connected: 0,
  connectErrors: 0,
  closed: 0,
  totalRxBytes: 0,
  totalRxFrames: 0,
  sent: { move: 0, dig: 0, place: 0, break: 0, hit: 0, pvp: 0, chat: 0 },
};

const bots = [];

class Bot {
  constructor(index) {
    this.index = index;
    this.home = homeFor(index, BOTS);
    this.x = this.home.x;
    this.y = GROUND_Y;
    this.z = this.home.z;
    this.yaw = Math.random() * Math.PI * 2;
    this.flying = false;
    this.rxBytes = 0;
    this.rxFrames = 0;
    this.state = new SnapshotState();
    this.selfId = null;
    this.alive = false;
    this.timers = [];
  }

  start() {
    let socket;
    try {
      socket = new WebSocket(URL);
    } catch {
      metrics.connectErrors += 1;
      return;
    }
    this.socket = socket;
    socket.binaryType = 'nodebuffer';

    socket.on('open', () => {
      metrics.connected += 1;
      this.alive = true;
      this.send({
        t: 'join',
        tenant: TENANT,
        world: 'main',
        name: '', // empty name + empty claim = anonymous guest (the server names us Guest<id>)
        skin: '#f2c18b',
        shirt: '#ff5d2e',
        hair: '#3a2a1a',
        claim: '',
      });
      this.timers.push(setInterval(() => this.move(), 1000 / MOVE_HZ));
      this.timers.push(setInterval(() => this.act(), 1000 / ACTION_HZ));
    });

    socket.on('message', (data, isBinary) => {
      const bytes = data.byteLength ?? data.length ?? 0;
      this.rxBytes += bytes;
      this.rxFrames += 1;
      metrics.totalRxBytes += bytes;
      metrics.totalRxFrames += 1;
      if (isBinary) this.onSnapshot(data);
      else this.onText(data);
    });

    socket.on('error', () => {
      metrics.connectErrors += 1;
    });

    socket.on('close', () => {
      this.alive = false;
      metrics.closed += 1;
      this.clearTimers();
    });
  }

  onText(data) {
    // The only text message we must react to is the server ping (so we aren't dropped as idle); we learn
    // our own player id from Welcome. Everything else (roster, events, room state) is just counted as RX.
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.t === 'welcome') {
      this.selfId = msg.you;
      if (Array.isArray(msg.spawn)) [this.x, this.y, this.z] = msg.spawn;
      return;
    }
    if (msg.t === 'ping') this.send({ t: 'pong', nonce: msg.nonce });
  }

  onSnapshot(buffer) {
    let frame;
    try {
      frame = decodeFrame(buffer);
    } catch {
      return; // a protocol drift shouldn't kill the bot mid-run; the next keyframe re-syncs us
    }
    this.state.apply(frame);
    // Keep our own position roughly anchored to what the server says it is (it clamps our moves), so our
    // edit/hit targeting uses coordinates the server agrees with.
    const me = this.selfId === null ? undefined : this.state.players.get(this.selfId);
    if (me) {
      this.x = me.x;
      this.y = me.y;
      this.z = me.z;
    }
  }

  // RUN/FLY: wander a step and send a Move. ~1 in 5 ticks toggles flying so Y varies (vertical movement).
  move() {
    if (!this.alive) return;
    if (randomInt(5) === 0) this.flying = !this.flying;
    this.yaw += (Math.random() - 0.5) * 0.6;
    const speed = this.flying ? 0.5 : 0.9;
    this.x = clamp(this.x + Math.cos(this.yaw) * speed, 1, WORLD_SIZE - 1);
    this.z = clamp(this.z + Math.sin(this.yaw) * speed, 1, WORLD_SIZE - 1);
    if (this.flying) this.y = clamp(this.y + (Math.random() - 0.5) * 1.5, GROUND_Y, GROUND_Y + 30);
    else this.y = GROUND_Y;
    this.send({ t: 'move', x: this.x, y: this.y, z: this.z, yaw: this.yaw, pitch: 0 });
    metrics.sent.move += 1;
  }

  // One discrete action from the weighted mix. Targeting (hit/pvp) reads the decoded snapshot for the
  // nearest entity in reach; dig/place/break use cells right next to us (no target id needed).
  act() {
    if (!this.alive) return;
    const action = pickAction();
    if (action === 'hit') return this.hitCreature();
    if (action === 'pvp') return this.attackPlayer();
    if (action === 'chat') return this.chat();
    return this.editNearby(action);
  }

  hitCreature() {
    const target = nearestWithin(this.state.creatures, this.x, this.z, MELEE_REACH, null);
    if (!target) return;
    this.send({ t: 'hit', id: target.id });
    metrics.sent.hit += 1;
  }

  attackPlayer() {
    const target = nearestWithin(this.state.players, this.x, this.z, PVP_REACH, this.selfId);
    if (!target) return;
    this.send({ t: 'attack_player', id: target.id });
    metrics.sent.pvp += 1;
  }

  chat() {
    this.send({ t: 'chat', text: CHAT_LINES[randomInt(CHAT_LINES.length)] });
    metrics.sent.chat += 1;
  }

  editNearby(action) {
    // A cell within edit reach of our feet: one block ahead, at roughly ground level.
    const x = Math.round(this.x + Math.cos(this.yaw) * (EDIT_REACH - 2));
    const z = Math.round(this.z + Math.sin(this.yaw) * (EDIT_REACH - 2));
    const y = Math.round(this.y - 1);
    if (action === 'dig') {
      this.send({ t: 'dig', x, y, z });
      metrics.sent.dig += 1;
      return;
    }
    if (action === 'place') {
      this.send({ t: 'edit', op: 'place', x, y, z, id: 1 });
      metrics.sent.place += 1;
      return;
    }
    this.send({ t: 'edit', op: 'break', x, y, z, id: 0 });
    metrics.sent.break += 1;
  }

  send(msg) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    // The server only accepts BINARY client frames now (symmetric with the binary snapshots it sends);
    // encode through the shared client codec mirror, same wire as the web client.
    this.socket.send(encodeClientMsg(msg));
  }

  clearTimers() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  stop() {
    this.clearTimers();
    this.alive = false;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// p-th percentile of a numeric array (nearest-rank). Used for the per-bot RX distribution.
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

function report(label, elapsedS) {
  const perBotBytes = bots.map((b) => b.rxBytes).sort((a, b) => a - b);
  const avgRxPerBotPerSec = metrics.connected === 0 ? 0 : metrics.totalRxBytes / metrics.connected / elapsedS;
  const avgFramesPerSec = metrics.connected === 0 ? 0 : metrics.totalRxFrames / metrics.connected / elapsedS;
  console.log(`\n[${label}] t=${elapsedS.toFixed(0)}s`);
  console.log(`  connected: ${metrics.connected}/${BOTS}  errors: ${metrics.connectErrors}  closed: ${metrics.closed}`);
  console.log(`  total RX: ${fmtBytes(metrics.totalRxBytes)} over ${metrics.totalRxFrames} frames`);
  console.log(`  avg RX/bot/sec: ${fmtBytes(avgRxPerBotPerSec)}  avg frames/bot/sec: ${avgFramesPerSec.toFixed(1)}`);
  console.log(
    `  per-bot RX p50: ${fmtBytes(percentile(perBotBytes, 50))}  p95: ${fmtBytes(percentile(perBotBytes, 95))}`,
  );
  console.log(
    `  sent: move=${metrics.sent.move} dig=${metrics.sent.dig} place=${metrics.sent.place} break=${metrics.sent.break} hit=${metrics.sent.hit} pvp=${metrics.sent.pvp} chat=${metrics.sent.chat}`,
  );
}

function fmtBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

async function main() {
  console.log(
    `Starting ${BOTS} bots → ${URL} (tenant=${TENANT}, spread=${SPREAD}, duration=${DURATION_S}s, ramp=${RAMP_BATCH}/${RAMP_DELAY_MS}ms)`,
  );
  const startedAt = Date.now();

  for (let i = 0; i < BOTS; i += 1) {
    const bot = new Bot(i);
    bots.push(bot);
    bot.start();
    if ((i + 1) % RAMP_BATCH === 0) {
      const pct = Math.round(((i + 1) / BOTS) * PROGRESS_PCT);
      process.stdout.write(`\r  ramping… ${i + 1}/${BOTS} (${pct}%)`);
      await sleep(RAMP_DELAY_MS);
    }
  }
  process.stdout.write('\n');

  const ticker = setInterval(() => {
    report('progress', (Date.now() - startedAt) / 1000);
  }, REPORT_EVERY_MS);

  await sleep(DURATION_S * 1000);

  clearInterval(ticker);
  const elapsedS = (Date.now() - startedAt) / 1000;
  report('FINAL', elapsedS);

  for (const bot of bots) bot.stop();
  // Give the close frames a moment to flush before exiting.
  await sleep(500);
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error('load harness failed:', error);
  process.exit(1);
});
