// Standalone browser network client for the Blockland server. It owns a single WebSocket,
// drives the connect/welcome/reconnect lifecycle, answers server pings, and surfaces server
// messages through typed handlers. It is NOT wired into the game engine yet — that wiring is a
// later phase. The socket and clock are injectable so tests can run deterministically.

import { debug } from './log';
import {
  adminBan,
  adminKick,
  adminResetWorld,
  adminResetScores,
  adminSetChat,
  adminSetPeace,
  adminSetPvp,
  adminSetRole,
  adminSetStructure,
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
  | 'room_closed';

type WelcomeMsg = Extract<ServerMsg, { t: 'welcome' }>;
type SnapshotMsg = Extract<ServerMsg, { t: 'snapshot' }>;
type EditMsg = Extract<ServerMsg, { t: 'edit' }>;
type EditBatchMsg = Extract<ServerMsg, { t: 'edit_batch' }>;
type ChatMsg = Extract<ServerMsg, { t: 'chat' }>;
type EventMsg = Extract<ServerMsg, { t: 'event' }>;
type RoomStateMsg = Extract<ServerMsg, { t: 'room_state' }>;
type HurtMsg = Extract<ServerMsg, { t: 'hurt' }>;
type RoleMsg = Extract<ServerMsg, { t: 'role' }>;
type AttackMsg = Extract<ServerMsg, { t: 'attack' }>;
type RespawnMsg = Extract<ServerMsg, { t: 'respawn' }>;

export interface NetHandlers {
  onState?(state: NetState): void;
  onWelcome?(msg: WelcomeMsg): void;
  onSnapshot?(msg: SnapshotMsg): void;
  onEdit?(msg: EditMsg): void;
  onEditBatch?(msg: EditBatchMsg): void;
  onChat?(msg: ChatMsg): void;
  onEvent?(msg: EventMsg): void;
  onRoomState?(msg: RoomStateMsg): void;
  onHurt?(msg: HurtMsg): void;
  onRole?(msg: RoleMsg): void;
  onAttack?(msg: AttackMsg): void;
  onRespawn?(msg: RespawnMsg): void;
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
  sendAttackPlayer(id: number): void;
  sendAdminResetWorld(): void;
  sendAdminResetScores(): void;
  sendAdminSetRole(id: number, role: Role): void;
  readonly ping: number;
  readonly state: NetState;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 10_000;

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
      setState('online');
      opts.handlers.onWelcome?.(msg);
      return;
    }
    if (msg.t === 'snapshot') {
      opts.handlers.onSnapshot?.(msg);
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
    reclaimed: 'kicked',
    claim_required: 'kicked',
  };

  function handleError(code: string, message: string): void {
    debug('net', 'error', { code, msg: message });
    opts.handlers.onError?.(code, message);
    const terminal = TERMINAL_ERRORS[code];
    if (terminal) { terminalReason = terminal; setState(terminal); }
  }

  function handleClose(): void {
    socket = null;
    if (closedByUser) {
      setState('offline');
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
    const next = socketFactory(opts.url);
    socket = next;
    next.onopen = () => {
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
    sendAttackPlayer(id): void {
      rawSend(encodeClientMsg(attackPlayer(id)));
    },
    sendAdminResetWorld(): void {
      rawSend(encodeClientMsg(adminResetWorld()));
    },
    sendAdminResetScores(): void {
      rawSend(encodeClientMsg(adminResetScores()));
    },
    sendAdminSetRole(id, role): void {
      rawSend(encodeClientMsg(adminSetRole(id, role)));
    },
    get ping(): number {
      return ping;
    },
    get state(): NetState {
      return state;
    },
  };
}
