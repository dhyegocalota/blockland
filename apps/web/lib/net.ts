// Standalone browser network client for the Blockland server. It owns a single WebSocket,
// drives the connect/welcome/reconnect lifecycle, answers server pings, and surfaces server
// messages through typed handlers. It is NOT wired into the game engine yet — that wiring is a
// later phase. The socket and clock are injectable so tests can run deterministically.

import { debug } from './log';
import {
  adminApprove,
  adminReject,
  adminUnban,
  adminBan,
  adminKick,
  adminReport,
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
  | 'rejected';

// The per-tick Snapshot travels as a compact numeric array (no field names) to keep it tiny; this
// module decodes it back into the named shape the rest of the client consumes, so only net.ts knows
// the index order and the kind table. Index order mirrors `PlayerState`/`CreatureState` in the Rust
// protocol crate, and the kind table mirrors `CreatureKind::ALL` (the `index()` the server emits).
const CREATURE_KINDS = ['pig', 'chicken', 'cow', 'slime', 'spider'] as const;

export interface SnapshotPlayer {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  ping_ms: number;
  score: number;
  hp: number;
}

export interface SnapshotCreature {
  id: number;
  kind: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  max_hp: number;
}

export interface SnapshotHeart {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface SnapshotMsg {
  t: 'snapshot';
  tick: number;
  players: SnapshotPlayer[];
  creatures: SnapshotCreature[];
  hearts: SnapshotHeart[];
}

function decodeSnapshot(msg: Extract<ServerMsg, { t: 'snapshot' }>): SnapshotMsg {
  const players: SnapshotPlayer[] = msg.p.map(
    ([id, x, y, z, yaw, pitch, ping_ms, score, hp]) => ({ id, x, y, z, yaw, pitch, ping_ms, score, hp }),
  );
  const creatures: SnapshotCreature[] = msg.c.map(([id, kindIndex, x, y, z, yaw, hp, max_hp]) => {
    const kind = CREATURE_KINDS[kindIndex];
    if (!kind) throw new Error(`unknown creature kind index ${kindIndex}`);
    return { id, kind, x, y, z, yaw, hp, max_hp };
  });
  // `h` (heart drops) is a newer snapshot field; a server one deploy behind omits it. Normalize the
  // absent wire field to an empty list at this protocol boundary so an old server can't crash the client.
  const hearts: SnapshotHeart[] = (msg.h ?? []).map(([id, x, y, z]) => ({ id, x, y, z }));
  return { t: 'snapshot', tick: msg.k, players, creatures, hearts };
}

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
  onRespawn?(msg: RespawnMsg): void;
  onInventory?(msg: InventoryMsg): void;
  onRoster?(msg: RosterMsg): void;
  onError?(code: string, msg: string): void;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
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
  sendAdminReport(id: number): void;
  sendAttackPlayer(id: number): void;
  sendAdminResetWorld(): void;
  sendAdminResetScores(): void;
  sendAdminSuspend(on: boolean): void;
  sendAdminSetRole(id: number, role: Role): void;
  sendAdminSetInfinite(on: boolean): void;
  sendAdminSetApproval(on: boolean): void;
  sendAdminApprove(accountId: string): void;
  sendAdminReject(accountId: string): void;
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
// Snapshot logging is throttled: the first one (proves the world is live) plus one every N after, so
// the debug console shows cadence without drowning in 30Hz spam.
const SNAPSHOT_LOG_EVERY = 150;

const defaultSocketFactory = (url: string): WebSocketLike =>
  new WebSocket(url) as unknown as WebSocketLike;

export function createNet(opts: NetOptions): NetClient {
  const socketFactory = opts.socketFactory ?? defaultSocketFactory;
  const now = opts.now ?? Date.now;
  const reconnect = opts.reconnect ?? true;

  let socket: WebSocketLike | null = null;
  let state: NetState = 'offline';
  let ping = 0;
  let attempt = 0;
  let closedByUser = false;
  let terminalReason: NetState | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPingAt: number | null = null;
  let snapshotCount = 0;
  // While held for admin approval we keep the player on a frozen "waiting" screen and silently re-join
  // every few seconds; the moment an admin approves, the next join returns a Welcome and they drop in.
  let waitingApproval = false;

  function setState(next: NetState): void {
    if (state === next) return;
    state = next;
    debug('net', 'state', { state: next });
    opts.handlers.onState?.(next);
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function backoffDelay(): number {
    return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  }

  function rawSend(data: string): void {
    if (socket === null) return;
    if (socket.readyState !== WS_OPEN) return;
    socket.send(data);
  }

  function handleMessage(data: string): void {
    const msg = parseServerMsg(data);
    if (msg.t === 'welcome') {
      attempt = 0;
      waitingApproval = false;
      setState('online');
      debug('net', 'welcome', { you: msg.you, world: msg.world, version: msg.version });
      opts.handlers.onWelcome?.(msg);
      return;
    }
    if (msg.t === 'snapshot') {
      snapshotCount += 1;
      if (snapshotCount === 1 || snapshotCount % SNAPSHOT_LOG_EVERY === 0) {
        debug('net', 'snapshot', { count: snapshotCount, tick: msg.k, players: msg.p.length, creatures: msg.c.length });
      }
      opts.handlers.onSnapshot?.(decodeSnapshot(msg));
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
    needs_login: 'kicked',
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
    next.onmessage = (event) => handleMessage(event.data);
    next.onclose = () => handleClose();
    next.onerror = () => debug('net', 'socket error');
  }

  return {
    connect(): void {
      closedByUser = false;
      terminalReason = null;
      attempt = 0;
      setState('connecting');
      open();
    },
    close(): void {
      closedByUser = true;
      clearReconnectTimer();
      socket?.close();
      if (socket === null) setState('offline');
    },
    sendMove(x, y, z, yaw, pitch): void {
      rawSend(encodeClientMsg(move(x, y, z, yaw, pitch)));
    },
    sendEdit(op, x, y, z, id): void {
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
      rawSend(encodeClientMsg(hit(id)));
    },
    sendRespawn(): void {
      rawSend(encodeClientMsg(respawn()));
    },
    sendDig(x, y, z): void {
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
    sendAdminReport(id): void {
      rawSend(encodeClientMsg(adminReport(id)));
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
