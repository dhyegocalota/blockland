// Offline-via-core network source: a `NetClient` (the same interface `net.ts`'s WebSocket client
// implements) backed by a local `WasmCore` instead of a socket. coop.ts builds its handlers once and asks
// for a NetClient; with the wasm flag on it gets THIS one, so the renderer/HUD/admin panel run identically
// — they just receive their `ServerMsg`s from the in-process core rather than the wire.
//
// The driver mirrors the WebSocket split exactly: every `send*` becomes a `core.input(playerId, ClientMsg
// BINARY, now)` — encoded through the SAME shared Rust codec the socket path uses (the wasm `encode_client_
// msg`), so online + offline speak one wire format; an internal rAF loop ticks the core and drains its
// outbound queue; each drained message is routed to the matching handler — JSON `ServerMsg` through
// `parseServerMsg` + the same `t`-switch net.ts uses, binary snapshots through the same wasm
// `SnapshotDecoder`. The first Welcome flips state to online.

import { debug, warn } from '../../log';
import { decodeSnapshot } from './wasm-snapshot-decoder';
import type { NetClient, NetHandlers, NetState } from '../../net';
import {
  adminApprove, adminBan, adminBanPending, adminKick, adminReject, adminResetScores, adminClearHistory, adminResetWorld,
  adminSetApproval, adminSetChat, adminSetInfinite, adminSetLimits, adminSetModes, adminSetPeace,
  adminSetPvp, adminSetRole, adminSetStructure, adminSuspend, adminUnban, attackPlayer, chat, dig, edit,
  editBatch, encodeClientMsg, hit, move, respawn, type ClientMsg, type EditCell, type EditOp, type Role,
} from '../../protocol';
import {
  createClientEncoder, createSnapshotDecoder, createWasmCore, OutboundKind, type EncodeClientMsg,
  type WasmCore, type WasmCoreInit, type WasmSnapshotDecoder,
} from './wasm-core-loader';

// Cells per EditBatch input; matches net.ts so the server-side batch handling sees identical-sized frames.
const BATCH_CHUNK = 256;

// The fixed, global room limits the offline core runs under — the same values the server reads from
// `tenants.toml` (which CLAUDE.md fixes globally; tenants.toml is branding only). The WasmCore deserializes
// these into its RoomConfig, so offline simulates with the identical edit/idle bounds as online.
//
// EXCEPT the movement anti-cheat: online, the room steps an over-budget move toward the client at only
// `max_speed * dt + 2` per tick (a rubber-band that converges a cheating/desynced player). Offline there is
// ONE local player and no cheating to prevent, so that clamp would only add a rubber-band the TS engine
// never had (it moved the player directly). We make the clamp a no-op by raising the speed cap + the
// per-second move budget far above any real move: the world spans WORLD_SIZE (163840) units, so a single
// tick can never move farther than that, and a cap above it keeps `dist <= max_speed * dt` always true —
// the move is taken whole (factor == 1), identical to the TS offline. Online keeps the real cap (its config
// is read straight from tenants.toml and is untouched here).
const OFFLINE_UNCLAMPED_RATE = 1_000_000.0;

export const OFFLINE_ROOM_LIMITS = {
  tick_hz: 20,
  max_players: 10,
  idle_secs: 45,
  edit_reach: 9.0,
  max_speed: OFFLINE_UNCLAMPED_RATE,
  move_per_sec: OFFLINE_UNCLAMPED_RATE,
  edit_per_sec: 25.0,
  chat_per_sec: 2.0,
} as const;

export interface WasmOfflineConfig {
  tenant: string;
  world: string;
  brand_name: string;
  brand_image: string;
  tick_hz: number;
  max_players: number;
  idle_secs: number;
  edit_reach: number;
  max_speed: number;
  move_per_sec: number;
  edit_per_sec: number;
  chat_per_sec: number;
}

// The JSON config the WasmCore constructor needs: the tenant/world/branding plus the fixed limits above.
export function wasmOfflineConfig(args: { tenant: string; world: string; brand: { name: string; image: string } }): WasmOfflineConfig {
  return { tenant: args.tenant, world: args.world, brand_name: args.brand.name, brand_image: args.brand.image, ...OFFLINE_ROOM_LIMITS };
}

// A fresh per-session seed (the room reseeds its RNG with it, so creature spawns differ run-to-run like the
// from-entropy native server). Math.random scaled into a u32 the core casts cleanly.
export function wasmOfflineSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

// Whether to install the core's tracing→console bridge — mirrors the web app's `?debug=1`/localStorage gate
// so the `[BL:*]` lines flow only when the user opted into debug logging.
export function wasmOfflineDebug(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).has('debug')) return true;
    return window.localStorage.getItem('bl-debug') === '1';
  } catch {
    return false;
  }
}

export interface WasmCoreSourceOptions {
  handlers: NetHandlers;
  name: string;
  look: { skin: string; shirt: string; hair: string };
  init: Omit<WasmCoreInit, 'nowMs' | 'wallMs'>;
  // Schedules the next driver step; returns a canceller. Defaults to requestAnimationFrame; injectable so
  // tests drive the loop deterministically without a browser clock.
  schedule?: (step: () => void) => () => void;
  // Monotonic + wall clocks the core threads through its time abstraction. Default performance.now/Date.now.
  now?: () => number;
  wall?: () => number;
  // Builds + inits the WasmCore (default: load the real wasm). Injected as a fake in tests.
  createCore?: (init: WasmCoreInit) => Promise<WasmCore>;
  // Builds the wasm snapshot decoder (default: the real wasm `SnapshotDecoder`). Injected as a fake in tests.
  createDecoder?: () => Promise<WasmSnapshotDecoder>;
  // Builds the wasm client-message encoder (default: the real wasm `encode_client_msg`). Injected in tests.
  createEncoder?: () => Promise<EncodeClientMsg>;
}

function defaultSchedule(step: () => void): () => void {
  const id = requestAnimationFrame(step);
  return () => cancelAnimationFrame(id);
}

export function createWasmCoreNet(opts: WasmCoreSourceOptions): NetClient {
  const handlers = opts.handlers;
  const schedule = opts.schedule ?? defaultSchedule;
  const now = opts.now ?? (() => performance.now());
  const wall = opts.wall ?? Date.now;
  const createCore = opts.createCore ?? createWasmCore;
  const createDecoder = opts.createDecoder ?? createSnapshotDecoder;
  const createEncoder = opts.createEncoder ?? createClientEncoder;

  let core: WasmCore | null = null;
  let decoder: WasmSnapshotDecoder | null = null;
  let encoder: EncodeClientMsg | null = null;
  let playerId: number | null = null;
  let state: NetState = 'offline';
  let ping = 0;
  let closed = false;
  let cancelStep: (() => void) | null = null;
  let lastStepAt: number | null = null;

  function setState(next: NetState): void {
    if (state === next) return;
    state = next;
    debug('wasmcore', 'state', { state: next });
    handlers.onState?.(next);
  }

  // Route one drained outbound message exactly like net.ts splits a socket frame: binary → the wasm snapshot
  // decoder → onSnapshot; JSON → parseServerMsg → the same `t`-switch. The first Welcome onlines us.
  function dispatch(json: string, binary: Uint8Array, kind: OutboundKind): void {
    if (kind === OutboundKind.Binary) {
      if (decoder === null) { warn('wasmcore', 'snapshot dropped (decoder not ready)'); return; }
      // Copy out of the wasm view (it may alias the module's memory) before handing it to the decoder.
      const bytes = new Uint8Array(binary.byteLength);
      bytes.set(binary);
      const snapshot = decodeSnapshot(decoder, bytes);
      if (snapshot === null) return;
      handlers.onSnapshot?.(snapshot);
      return;
    }
    const msg = JSON.parse(json) as { t: string } & Record<string, unknown>;
    routeJson(msg);
  }

  function routeJson(msg: { t: string } & Record<string, unknown>): void {
    if (msg.t === 'welcome') { setState('online'); handlers.onWelcome?.(msg as never); return; }
    if (msg.t === 'snapshot') { handlers.onSnapshot?.(msg as never); return; }
    if (msg.t === 'edit') { handlers.onEdit?.(msg as never); return; }
    if (msg.t === 'edit_batch') { handlers.onEditBatch?.(msg as never); return; }
    if (msg.t === 'chat') { handlers.onChat?.(msg as never); return; }
    if (msg.t === 'event') { handlers.onEvent?.(msg as never); return; }
    if (msg.t === 'room_state') { handlers.onRoomState?.(msg as never); return; }
    if (msg.t === 'pending_approvals') { handlers.onPendingApprovals?.(msg as never); return; }
    if (msg.t === 'bans') { handlers.onBans?.(msg as never); return; }
    if (msg.t === 'hurt') { handlers.onHurt?.(msg as never); return; }
    if (msg.t === 'role') { handlers.onRole?.(msg as never); return; }
    if (msg.t === 'attack') { handlers.onAttack?.(msg as never); return; }
    if (msg.t === 'swing') { handlers.onSwing?.(msg as never); return; }
    if (msg.t === 'respawn') { handlers.onRespawn?.(msg as never); return; }
    if (msg.t === 'inventory') { handlers.onInventory?.(msg as never); return; }
    if (msg.t === 'roster') { handlers.onRoster?.(msg as never); return; }
    if (msg.t === 'error') { handlers.onError?.(msg.code as string, msg.msg as string); return; }
  }

  // One simulation step: advance the core by the elapsed dt, then drain + route everything it produced.
  function step(): void {
    if (closed || core === null) return;
    const at = now();
    const dt = lastStepAt === null ? 0 : (at - lastStepAt) / 1000;
    lastStepAt = at;
    core.tick(at, wall(), dt);
    for (const out of core.drain_outbound()) dispatch(out.json, out.binary, out.kind as OutboundKind);
    if (closed) return;
    cancelStep = schedule(step);
  }

  function feed(msg: ClientMsg): void {
    if (core === null || playerId === null || encoder === null) return;
    core.input(playerId, encodeClientMsg(encoder, msg), now());
  }

  return {
    connect(): void {
      closed = false;
      setState('connecting');
      debug('wasmcore', 'connecting', { name: opts.name });
      // Build the core, the snapshot decoder AND the client encoder before the first step drains/feeds, so the
      // very first keyframe the core emits is decoded (no dropped frame) and the first input encodes. All run
      // on the inited wasm.
      Promise.all([createCore({ ...opts.init, nowMs: now(), wallMs: wall() }), createDecoder(), createEncoder()])
        .then(([builtCore, builtDecoder, builtEncoder]) => {
          if (closed) { builtCore.free(); builtDecoder.free(); return; }
          core = builtCore;
          decoder = builtDecoder;
          encoder = builtEncoder;
          playerId = builtCore.add_local_player(opts.name, JSON.stringify(opts.look));
          debug('wasmcore', 'local player admitted', { playerId });
          lastStepAt = now();
          cancelStep = schedule(step);
        })
        .catch((error) => {
          warn('wasmcore', 'core init failed', { error: String(error) });
          handlers.onError?.('wasm_init', String(error));
          setState('offline');
        });
    },
    close(): void {
      closed = true;
      cancelStep?.();
      cancelStep = null;
      core?.free();
      core = null;
      decoder?.free();
      decoder = null;
      encoder = null;
      playerId = null;
      setState('offline');
    },
    sendMove(x, y, z, yaw, pitch): void { feed(move(x, y, z, yaw, pitch)); },
    sendEdit(op: EditOp, x, y, z, id): void { feed(edit(op, x, y, z, id)); },
    sendEditBatch(edits: EditCell[]): void {
      for (let i = 0; i < edits.length; i += BATCH_CHUNK) feed(editBatch(edits.slice(i, i + BATCH_CHUNK)));
    },
    sendChat(text): void { feed(chat(text)); },
    sendHit(id): void { feed(hit(id)); },
    sendRespawn(): void { feed(respawn()); },
    sendDig(x, y, z): void { feed(dig(x, y, z)); },
    sendAdminSetPeace(on): void { feed(adminSetPeace(on)); },
    sendAdminSetStructure(kind, allowed): void { feed(adminSetStructure(kind, allowed)); },
    sendAdminSetPvp(on): void { feed(adminSetPvp(on)); },
    sendAdminSetChat(on): void { feed(adminSetChat(on)); },
    sendAdminKick(id): void { feed(adminKick(id)); },
    sendAdminBan(id): void { feed(adminBan(id)); },
    sendAttackPlayer(id): void { feed(attackPlayer(id)); },
    sendAdminResetWorld(): void { feed(adminResetWorld()); },
    sendAdminResetScores(): void { feed(adminResetScores()); },
    sendAdminClearHistory(): void { feed(adminClearHistory()); },
    sendAdminSuspend(on): void { feed(adminSuspend(on)); },
    sendAdminSetRole(id, role: Role): void { feed(adminSetRole(id, role)); },
    sendAdminSetInfinite(on): void { feed(adminSetInfinite(on)); },
    sendAdminSetApproval(on): void { feed(adminSetApproval(on)); },
    sendAdminApprove(accountId): void { feed(adminApprove(accountId)); },
    sendAdminReject(accountId): void { feed(adminReject(accountId)); },
    sendAdminBanPending(accountId): void { feed(adminBanPending(accountId)); },
    sendAdminUnban(ip): void { feed(adminUnban(ip)); },
    sendAdminSetLimits(playtimeLimitMin, playtimeWindowH): void { feed(adminSetLimits(playtimeLimitMin, playtimeWindowH)); },
    sendAdminSetModes(onlineAllowed, offlineAllowed): void { feed(adminSetModes(onlineAllowed, offlineAllowed)); },
    get ping(): number { return ping; },
    get state(): NetState { return state; },
  };
}
