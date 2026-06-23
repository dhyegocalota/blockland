// Standalone browser network client for the Blockland server. It owns a single WebSocket,
// drives the connect/welcome/reconnect lifecycle, answers server pings, and surfaces server
// messages through typed handlers. It is NOT wired into the game engine yet — that wiring is a
// later phase. The socket and clock are injectable so tests can run deterministically.

import { debug, warn } from './log';
import { DebugEventDir, DebugEventKind, debugReportRing, type Vec3Like } from './engine/debug-report';
import { decodeSnapshot } from './snapshot-codec';
import type { SnapshotMsg } from './net-snapshot';
import {
  adminApprove,
  adminReject,
  adminBanPending,
  adminUnban,
  adminBan,
  adminKick,
  adminResetWorld,
  adminResetScores,
  adminSuspend,
  adminSetApproval,
  adminSetChat,
  adminSetInfinite,
  adminSetPeace,
  adminSetPvp,
  adminSetRole,
  adminSetStructure,
  adminSetLimits,
  adminSetModes,
  attackPlayer,
  chat,
  edit,
  editBatch,
  encodeClientMsg,
  hit,
  join,
  move,
  dig,
  parseServerMsg,
  pong,
  respawn,
  type EditCell,
  type EditOp,
  type Role,
  type ServerMsg,
} from './protocol';

// Cells per EditBatch frame; keeps each WebSocket message well under the server's text-size cap.
const BATCH_CHUNK = 256;
// WebSocket.OPEN, by value — `WebSocket` is not a global in the Node test/CI environment.
const WS_OPEN = 1;

export type NetState =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'banned'
  | 'kicked'
  | 'room_closed'
  | 'time_up'
  | 'online_blocked'
  | 'needs_approval'
  | 'needs_login'
  | 'rejected';

// The per-tick Snapshot is the one message that travels as a compact BINARY frame (every other message
// stays JSON text). `snapshot-codec.ts` decodes the bytes back into the named shape the rest of the
// client consumes; `net-snapshot.ts` owns the shared shapes + kind table. We re-export them here so the
// engine keeps importing snapshot types from `net` unchanged.
export type {
  SnapshotPlayer,
  SnapshotCreature,
  SnapshotHeart,
  SnapshotMsg,
} from './net-snapshot';

type WelcomeMsg = Extract<ServerMsg, { t: 'welcome' }>;
type EditMsg = Extract<ServerMsg, { t: 'edit' }>;
type EditBatchMsg = Extract<ServerMsg, { t: 'edit_batch' }>;
type ChatMsg = Extract<ServerMsg, { t: 'chat' }>;
type EventMsg = Extract<ServerMsg, { t: 'event' }>;
type RoomStateMsg = Extract<ServerMsg, { t: 'room_state' }>;
type PendingApprovalsMsg = Extract<ServerMsg, { t: 'pending_approvals' }>;
type BansMsg = Extract<ServerMsg, { t: 'bans' }>;
type HurtMsg = Extract<ServerMsg, { t: 'hurt' }>;
type RoleMsg = Extract<ServerMsg, { t: 'role' }>;
type AttackMsg = Extract<ServerMsg, { t: 'attack' }>;
type SwingMsg = Extract<ServerMsg, { t: 'swing' }>;
type RespawnMsg = Extract<ServerMsg, { t: 'respawn' }>;
type InventoryMsg = Extract<ServerMsg, { t: 'inventory' }>;
type RosterMsg = Extract<ServerMsg, { t: 'roster' }>;

export interface NetHandlers {
  onState?(state: NetState): void;
  onWelcome?(msg: WelcomeMsg): void;
  onSnapshot?(msg: SnapshotMsg): void;
  onEdit?(msg: EditMsg): void;
  onEditBatch?(msg: EditBatchMsg): void;
  onChat?(msg: ChatMsg): void;
  onEvent?(msg: EventMsg): void;
  onRoomState?(msg: RoomStateMsg): void;
  onPendingApprovals?(msg: PendingApprovalsMsg): void;
  onBans?(msg: BansMsg): void;
  onHurt?(msg: HurtMsg): void;
  onRole?(msg: RoleMsg): void;
  onAttack?(msg: AttackMsg): void;
  onSwing?(msg: SwingMsg): void;
  onRespawn?(msg: RespawnMsg): void;
  onInventory?(msg: InventoryMsg): void;
  onRoster?(msg: RosterMsg): void;
  onError?(code: string, msg: string): void;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  // 'arraybuffer' so the per-tick snapshot binary frame arrives as an ArrayBuffer we can decode directly,
  // without an async Blob read. Set on every socket the moment it is created.
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  // Text frames carry a JSON string; the snapshot binary frame carries an ArrayBuffer (or a Blob if a
  // socket ignored `binaryType`). `handleMessage` branches on the runtime type.
  onmessage: ((event: { data: string | ArrayBuffer | Blob }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface NetOptions {
  url: string;
  tenant: string;
  world: string;
  name: string;
  skin: string;
  shirt: string;
  hair: string;
  claim: string;
  handlers: NetHandlers;
  socketFactory?: (url: string) => WebSocketLike;
  now?: () => number;
  reconnect?: boolean;
  // Source of browser connectivity events (default: window online/offline). The browser flips these the
  // instant the NIC drops/returns — far faster than waiting out the liveness watchdog. Injectable so the
  // reconnect reaction is unit-testable without a DOM.
  connectivity?: Connectivity;
}

export interface Connectivity {
  subscribe(onOffline: () => void, onOnline: () => void): () => void;
}

function windowConnectivity(): Connectivity {
  return {
    subscribe(onOffline, onOnline) {
      if (typeof window === 'undefined') return () => {};
      window.addEventListener('offline', onOffline);
      window.addEventListener('online', onOnline);
      return () => {
        window.removeEventListener('offline', onOffline);
        window.removeEventListener('online', onOnline);
      };
    },
  };
}

export interface NetClient {
  connect(): void;
  close(): void;
  sendMove(x: number, y: number, z: number, yaw: number, pitch: number): void;
  sendEdit(op: EditOp, x: number, y: number, z: number, id: number): void;
  sendEditBatch(edits: EditCell[]): void;
  sendChat(text: string): void;
  sendHit(id: number): void;
  sendRespawn(): void;
  sendDig(x: number, y: number, z: number): void;
  sendAdminSetPeace(on: boolean): void;
  sendAdminSetStructure(kind: string, allowed: boolean): void;
  sendAdminSetPvp(on: boolean): void;
  sendAdminSetChat(on: boolean): void;
  sendAdminKick(id: number): void;
  sendAdminBan(id: number): void;
  sendAttackPlayer(id: number): void;
  sendAdminResetWorld(): void;
  sendAdminResetScores(): void;
  sendAdminSuspend(on: boolean): void;
  sendAdminSetRole(id: number, role: Role): void;
  sendAdminSetInfinite(on: boolean): void;
  sendAdminSetApproval(on: boolean): void;
  sendAdminApprove(accountId: string): void;
  sendAdminReject(accountId: string): void;
  sendAdminBanPending(accountId: string): void;
  sendAdminUnban(ip: string): void;
  sendAdminSetLimits(playtimeLimitMin: number, playtimeWindowH: number): void;
  sendAdminSetModes(onlineAllowed: boolean, offlineAllowed: boolean): void;
  readonly ping: number;
  readonly state: NetState;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 10_000;
// How often a player held for approval silently retries the join while they wait on the frozen screen.
const APPROVAL_RETRY_MS = 3_000;
// Silent-drop detection: the server streams snapshots (~30Hz) + pings, so going this long with NO message
// while supposedly online means the link is dead (internet dropped, half-open socket that never cleanly
// closed). We force the socket closed so the normal reconnect path takes over. Checked on this interval.
const LIVENESS_TIMEOUT_MS = 5_000;
const LIVENESS_CHECK_MS = 1_000;
// Snapshot logging is throttled: the first one (proves the world is live) plus one every N after, so
// the debug console shows cadence without drowning in 30Hz spam.
const SNAPSHOT_LOG_EVERY = 150;

const defaultSocketFactory = (url: string): WebSocketLike =>
  new WebSocket(url) as unknown as WebSocketLike;

export function createNet(opts: NetOptions): NetClient {
  const socketFactory = opts.socketFactory ?? defaultSocketFactory;
  const now = opts.now ?? Date.now;
  const reconnect = opts.reconnect ?? true;
  const connectivity = opts.connectivity ?? windowConnectivity();
  let connectivityUnsub: (() => void) | null = null;
  let pageHideHandler: (() => void) | null = null;

  let socket: WebSocketLike | null = null;
  let state: NetState = 'offline';
  let ping = 0;
  let attempt = 0;
  let closedByUser = false;
  let terminalReason: NetState | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let lastMessageAt: number | null = null;
  let lastPingAt: number | null = null;
  let snapshotCount = 0;
  // The freshest client player position the engine has thrown out as a Move; we stamp every recorded
  // Dig/Hit/Edit with it so the diagnostics ring shows where the client believed it was aiming from.
  let lastMovePos: Vec3Like = { x: 0, y: 0, z: 0 };
  // While held for admin approval we keep the player on a frozen "waiting" screen and silently re-join
  // every few seconds; the moment an admin approves, the next join returns a Welcome and they drop in.
  let waitingApproval = false;

  function setState(next: NetState): void {
    if (state === next) return;
    state = next;
    debugReportRing.push({ dir: DebugEventDir.State, kind: DebugEventKind.NetState, text: next });
    debug('net', 'state', { state: next });
    opts.handlers.onState?.(next);
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function clearLivenessTimer(): void {
    if (livenessTimer === null) return;
    clearInterval(livenessTimer);
    livenessTimer = null;
  }

  // Abandon the current socket and drive the reconnect transition ourselves. A dead socket while OFFLINE
  // often never fires `onclose` (the close handshake can't complete), so we can't wait for it — detach the
  // corpse and run the close path directly. No-op unless we currently believe we're online.
  function dropForReconnect(reason: string): void {
    if (state !== 'online') return;
    warn('net', 'forcing reconnect', { reason });
    const dead = socket;
    if (dead) dead.onclose = null;
    try {
      dead?.close();
    } catch {
      /* already gone */
    }
    handleClose();
  }

  // The browser came back online: don't sit out the backoff, retry the connection right now.
  function reconnectNow(): void {
    if (state !== 'reconnecting') return;
    clearReconnectTimer();
    attempt = 0;
    open();
  }

  // Watch for a silently-dead socket: once online, if no server message arrives within the timeout the
  // link is gone, so reconnect (backoff + rejoin + reconnecting UI). The browser `offline` event usually
  // beats this, but covers half-open sockets that drop without the NIC going down.
  function startLiveness(): void {
    clearLivenessTimer();
    lastMessageAt = now();
    livenessTimer = setInterval(() => {
      if (state !== 'online') return;
      if (lastMessageAt === null) return;
      if (now() - lastMessageAt <= LIVENESS_TIMEOUT_MS) return;
      dropForReconnect(`silent ${now() - lastMessageAt}ms`);
    }, LIVENESS_CHECK_MS);
  }

  function backoffDelay(): number {
    return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  }

  function rawSend(data: string): void {
    if (socket === null) return;
    if (socket.readyState !== WS_OPEN) return;
    socket.send(data);
  }

  function recordSend(kind: DebugEventKind, fields: { cell?: Vec3Like; id?: number }): void {
    debugReportRing.push({ dir: DebugEventDir.Send, kind, pos: { ...lastMovePos }, cell: fields.cell, id: fields.id });
  }

  // Reach estimate the server would measure: distance from the last Move position to the target cell's
  // center. When this stays small but the server keeps rejecting the dig/hit, its tracked pose is stale.
  function reachTo(cell: Vec3Like): number {
    const dx = lastMovePos.x - (cell.x + 0.5);
    const dy = lastMovePos.y - (cell.y + 0.5);
    const dz = lastMovePos.z - (cell.z + 0.5);
    return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) / 100;
  }

  // A binary frame is always the per-tick snapshot (the only message that goes binary); decode the bytes
  // and feed the same onSnapshot path the text path used to. A Blob (a socket that ignored `binaryType`)
  // is read to an ArrayBuffer first.
  function handleBinary(buffer: ArrayBuffer): void {
    lastMessageAt = now();
    const snapshot: SnapshotMsg = decodeSnapshot(buffer);
    snapshotCount += 1;
    if (snapshotCount === 1 || snapshotCount % SNAPSHOT_LOG_EVERY === 0) {
      debug('net', 'snapshot', { count: snapshotCount, tick: snapshot.tick, players: snapshot.players.length, creatures: snapshot.creatures.length });
    }
    opts.handlers.onSnapshot?.(snapshot);
  }

  function handleData(data: string | ArrayBuffer | Blob): void {
    if (data instanceof ArrayBuffer) {
      handleBinary(data);
      return;
    }
    if (typeof data !== 'string') {
      data.arrayBuffer().then(handleBinary);
      return;
    }
    handleMessage(data);
  }

  function handleMessage(data: string): void {
    lastMessageAt = now();
    const msg = parseServerMsg(data);
    if (msg.t === 'welcome') {
      attempt = 0;
      waitingApproval = false;
      setState('online');
      startLiveness();
      debug('net', 'welcome', { you: msg.you, world: msg.world, version: msg.version });
      opts.handlers.onWelcome?.(msg);
      return;
    }
    if (msg.t === 'edit') {
      opts.handlers.onEdit?.(msg);
      return;
    }
    if (msg.t === 'edit_batch') {
      opts.handlers.onEditBatch?.(msg);
      return;
    }
    if (msg.t === 'chat') {
      opts.handlers.onChat?.(msg);
      return;
    }
    if (msg.t === 'event') {
      opts.handlers.onEvent?.(msg);
      return;
    }
    if (msg.t === 'room_state') {
      opts.handlers.onRoomState?.(msg);
      return;
    }
    if (msg.t === 'pending_approvals') {
      opts.handlers.onPendingApprovals?.(msg);
      return;
    }
    if (msg.t === 'bans') {
      opts.handlers.onBans?.(msg);
      return;
    }
    if (msg.t === 'hurt') {
      opts.handlers.onHurt?.(msg);
      return;
    }
    if (msg.t === 'role') {
      opts.handlers.onRole?.(msg);
      return;
    }
    if (msg.t === 'attack') {
      opts.handlers.onAttack?.(msg);
      return;
    }
    if (msg.t === 'swing') {
      opts.handlers.onSwing?.(msg);
      return;
    }
    if (msg.t === 'respawn') {
      opts.handlers.onRespawn?.(msg);
      return;
    }
    if (msg.t === 'inventory') {
      opts.handlers.onInventory?.(msg);
      return;
    }
    if (msg.t === 'roster') {
      opts.handlers.onRoster?.(msg);
      return;
    }
    if (msg.t === 'ping') {
      const arrivedAt = now();
      if (lastPingAt !== null) ping = arrivedAt - lastPingAt;
      lastPingAt = arrivedAt;
      rawSend(encodeClientMsg(pong(msg.nonce)));
      return;
    }
    if (msg.t === 'error') {
      handleError(msg.code, msg.msg);
      return;
    }
  }

  // Error codes that must NOT auto-reconnect (a reconnect would just be kicked/rejected again).
  const TERMINAL_ERRORS: Record<string, NetState> = {
    banned: 'banned',
    idle_timeout: 'kicked',
    kicked: 'kicked',
    room_closed: 'room_closed',
    suspended: 'room_closed',
    time_up: 'time_up',
    online_blocked: 'online_blocked',
    reclaimed: 'kicked',
    claim_required: 'kicked',
    needs_login: 'needs_login',
    rejected: 'rejected',
  };

  function handleError(code: string, message: string): void {
    debug('net', 'error', { code, msg: message });
    opts.handlers.onError?.(code, message);
    // Not terminal: stay on the frozen waiting screen and let the close handler re-join until approved.
    if (code === 'needs_approval') { waitingApproval = true; setState('needs_approval'); return; }
    const terminal = TERMINAL_ERRORS[code];
    if (terminal) { waitingApproval = false; terminalReason = terminal; setState(terminal); }
  }

  function handleClose(): void {
    socket = null;
    clearLivenessTimer();
    if (closedByUser) {
      setState('offline');
      return;
    }
    if (waitingApproval) {
      reconnectTimer = setTimeout(open, APPROVAL_RETRY_MS);
      return;
    }
    if (terminalReason !== null) {
      setState(terminalReason);
      return;
    }
    if (!reconnect) {
      setState('offline');
      return;
    }
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    setState('reconnecting');
    const delay = backoffDelay();
    attempt += 1;
    reconnectTimer = setTimeout(open, delay);
  }

  function open(): void {
    clearReconnectTimer();
    snapshotCount = 0;
    debug('net', 'opening socket', { url: opts.url, tenant: opts.tenant, attempt, waitingApproval });
    const next = socketFactory(opts.url);
    socket = next;
    next.binaryType = 'arraybuffer';
    next.onopen = () => {
      debug('net', 'socket open, joining', { name: opts.name, world: opts.world });
      rawSend(encodeClientMsg(join({
        tenant: opts.tenant,
        world: opts.world,
        name: opts.name,
        skin: opts.skin,
        shirt: opts.shirt,
        hair: opts.hair,
        claim: opts.claim,
      })));
    };
    next.onmessage = (event) => handleData(event.data);
    next.onclose = () => handleClose();
    next.onerror = () => debug('net', 'socket error');
  }

  return {
    connect(): void {
      closedByUser = false;
      terminalReason = null;
      attempt = 0;
      connectivityUnsub?.();
      connectivityUnsub = connectivity.subscribe(
        () => dropForReconnect('browser offline'),
        () => reconnectNow(),
      );
      // On page reload / tab close, close the socket cleanly so the server gets a Close frame and removes
      // the avatar immediately (instead of holding the slot for the reconnect grace). Belt-and-suspenders
      // over the browser's own 1001 close, which a fast reload can skip.
      if (typeof window !== 'undefined') {
        pageHideHandler = () => { closedByUser = true; socket?.close(); };
        window.addEventListener('pagehide', pageHideHandler);
      }
      setState('connecting');
      open();
    },
    close(): void {
      closedByUser = true;
      connectivityUnsub?.();
      connectivityUnsub = null;
      if (pageHideHandler && typeof window !== 'undefined') {
        window.removeEventListener('pagehide', pageHideHandler);
        pageHideHandler = null;
      }
      clearReconnectTimer();
      clearLivenessTimer();
      socket?.close();
      if (socket === null) setState('offline');
    },
    sendMove(x, y, z, yaw, pitch): void {
      lastMovePos = { x, y, z };
      debugReportRing.push({ dir: DebugEventDir.Send, kind: DebugEventKind.Move, pos: { x, y, z } });
      rawSend(encodeClientMsg(move(x, y, z, yaw, pitch)));
    },
    sendEdit(op, x, y, z, id): void {
      recordSend(DebugEventKind.Edit, { cell: { x, y, z }, id });
      debug('action', 'edit send', { op, x, y, z, id, px: lastMovePos.x, py: lastMovePos.y, pz: lastMovePos.z, reach: reachTo({ x, y, z }) });
      rawSend(encodeClientMsg(edit(op, x, y, z, id)));
    },
    sendEditBatch(edits): void {
      for (let i = 0; i < edits.length; i += BATCH_CHUNK) {
        rawSend(encodeClientMsg(editBatch(edits.slice(i, i + BATCH_CHUNK))));
      }
    },
    sendChat(text): void {
      rawSend(encodeClientMsg(chat(text)));
    },
    sendHit(id): void {
      recordSend(DebugEventKind.Hit, { id });
      debug('action', 'hit send', { id, px: lastMovePos.x, py: lastMovePos.y, pz: lastMovePos.z });
      rawSend(encodeClientMsg(hit(id)));
    },
    sendRespawn(): void {
      rawSend(encodeClientMsg(respawn()));
    },
    sendDig(x, y, z): void {
      recordSend(DebugEventKind.Dig, { cell: { x, y, z } });
      debug('action', 'dig send', { x, y, z, px: lastMovePos.x, py: lastMovePos.y, pz: lastMovePos.z, reach: reachTo({ x, y, z }) });
      rawSend(encodeClientMsg(dig(x, y, z)));
    },
    sendAdminSetPeace(on): void {
      rawSend(encodeClientMsg(adminSetPeace(on)));
    },
    sendAdminSetStructure(kind, allowed): void {
      rawSend(encodeClientMsg(adminSetStructure(kind, allowed)));
    },
    sendAdminSetPvp(on): void {
      rawSend(encodeClientMsg(adminSetPvp(on)));
    },
    sendAdminSetChat(on): void {
      rawSend(encodeClientMsg(adminSetChat(on)));
    },
    sendAdminKick(id): void {
      rawSend(encodeClientMsg(adminKick(id)));
    },
    sendAdminBan(id): void {
      rawSend(encodeClientMsg(adminBan(id)));
    },
    sendAttackPlayer(id): void {
      rawSend(encodeClientMsg(attackPlayer(id)));
    },
    sendAdminResetWorld(): void {
      rawSend(encodeClientMsg(adminResetWorld()));
    },
    sendAdminResetScores(): void {
      rawSend(encodeClientMsg(adminResetScores()));
    },
    sendAdminSuspend(on): void {
      rawSend(encodeClientMsg(adminSuspend(on)));
    },
    sendAdminSetRole(id, role): void {
      rawSend(encodeClientMsg(adminSetRole(id, role)));
    },
    sendAdminSetInfinite(on): void {
      rawSend(encodeClientMsg(adminSetInfinite(on)));
    },
    sendAdminSetApproval(on): void {
      rawSend(encodeClientMsg(adminSetApproval(on)));
    },
    sendAdminApprove(accountId): void {
      rawSend(encodeClientMsg(adminApprove(accountId)));
    },
    sendAdminReject(accountId): void {
      rawSend(encodeClientMsg(adminReject(accountId)));
    },
    sendAdminBanPending(accountId): void {
      rawSend(encodeClientMsg(adminBanPending(accountId)));
    },
    sendAdminUnban(ip): void {
      rawSend(encodeClientMsg(adminUnban(ip)));
    },
    sendAdminSetLimits(playtimeLimitMin, playtimeWindowH): void {
      rawSend(encodeClientMsg(adminSetLimits(playtimeLimitMin, playtimeWindowH)));
    },
    sendAdminSetModes(onlineAllowed, offlineAllowed): void {
      rawSend(encodeClientMsg(adminSetModes(onlineAllowed, offlineAllowed)));
    },
    get ping(): number {
      return ping;
    },
    get state(): NetState {
      return state;
    },
  };
}
