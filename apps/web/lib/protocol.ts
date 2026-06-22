// Typed client/server wire helpers. The message shapes come from `protocol.gen.ts`, which is
// AUTO-GENERATED from the Rust `protocol` crate (cargo test -p protocol) — so client and server
// can never drift. This module adds small typed factories the client uses to build messages.

import type { ClientMsg, EditCell, EditOp, Role, ServerMsg } from './protocol.gen';

export type { BanEntry, Brand, ClientMsg, CreatureState, EditCell, EditOp, InventoryItem, PlayerState, Role, ServerMsg } from './protocol.gen';

export const join = (params: {
  tenant: string;
  world: string;
  name: string;
  skin: string;
  shirt: string;
  hair: string;
  claim: string;
}): ClientMsg => ({ t: 'join', ...params });

export const move = (x: number, y: number, z: number, yaw: number, pitch: number): ClientMsg => ({
  t: 'move',
  x,
  y,
  z,
  yaw,
  pitch,
});

export const edit = (op: EditOp, x: number, y: number, z: number, id: number): ClientMsg => ({
  t: 'edit',
  op,
  x,
  y,
  z,
  id,
});

export const pong = (nonce: number): ClientMsg => ({ t: 'pong', nonce });

export const hit = (id: number): ClientMsg => ({ t: 'hit', id });

export const respawn = (): ClientMsg => ({ t: 'respawn' });

export const dig = (x: number, y: number, z: number): ClientMsg => ({ t: 'dig', x, y, z });

export const chat = (text: string): ClientMsg => ({ t: 'chat', text });

export const editBatch = (edits: EditCell[]): ClientMsg => ({ t: 'edit_batch', edits });

export const adminSetPeace = (on: boolean): ClientMsg => ({ t: 'admin_set_peace', on });

export const adminSetStructure = (kind: string, allowed: boolean): ClientMsg => ({
  t: 'admin_set_structure',
  kind,
  allowed,
});

export const adminSetPvp = (on: boolean): ClientMsg => ({ t: 'admin_set_pvp', on });

export const adminSetChat = (on: boolean): ClientMsg => ({ t: 'admin_set_chat', on });

export const adminSetInfinite = (on: boolean): ClientMsg => ({ t: 'admin_set_infinite', on });

export const adminKick = (id: number): ClientMsg => ({ t: 'admin_kick', id });

export const adminBan = (id: number): ClientMsg => ({ t: 'admin_ban', id });

export const adminReport = (id: number): ClientMsg => ({ t: 'admin_report', id });

export const attackPlayer = (id: number): ClientMsg => ({ t: 'attack_player', id });

export const adminResetWorld = (): ClientMsg => ({ t: 'admin_reset_world' });

export const adminResetScores = (): ClientMsg => ({ t: 'admin_reset_scores' });

export const adminSuspend = (on: boolean): ClientMsg => ({ t: 'admin_suspend', on });

export const adminSetRole = (id: number, role: Role): ClientMsg => ({ t: 'admin_set_role', id, role });

export const adminSetApproval = (on: boolean): ClientMsg => ({ t: 'admin_set_approval', on });

export const adminApprove = (accountId: string): ClientMsg => ({ t: 'admin_approve', account_id: accountId });

export const adminReject = (accountId: string): ClientMsg => ({ t: 'admin_reject', account_id: accountId });

export const adminUnban = (ip: string): ClientMsg => ({ t: 'admin_unban', ip });

export const adminSetLimits = (playtimeLimitMin: number, playtimeWindowH: number): ClientMsg => ({
  t: 'admin_set_limits',
  playtime_limit_min: playtimeLimitMin,
  playtime_window_h: playtimeWindowH,
});

export const adminSetModes = (onlineAllowed: boolean, offlineAllowed: boolean): ClientMsg => ({
  t: 'admin_set_modes',
  online_allowed: onlineAllowed,
  offline_allowed: offlineAllowed,
});

export const encodeClientMsg = (msg: ClientMsg): string => JSON.stringify(msg);

export const parseServerMsg = (data: string): ServerMsg => JSON.parse(data) as ServerMsg;
