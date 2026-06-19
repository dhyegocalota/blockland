// Typed client/server wire helpers. The message shapes come from `protocol.gen.ts`, which is
// AUTO-GENERATED from the Rust `protocol` crate (cargo test -p protocol) — so client and server
// can never drift. This module adds small typed factories the client uses to build messages.

import type { ClientMsg, EditCell, EditOp, ServerMsg } from './protocol.gen';

export type { Brand, ClientMsg, EditCell, EditOp, PlayerState, ServerMsg } from './protocol.gen';

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

export const chat = (text: string): ClientMsg => ({ t: 'chat', text });

export const editBatch = (edits: EditCell[]): ClientMsg => ({ t: 'edit_batch', edits });

export const adminSetPeace = (on: boolean): ClientMsg => ({ t: 'admin_set_peace', on });

export const adminSetStructure = (kind: string, allowed: boolean): ClientMsg => ({
  t: 'admin_set_structure',
  kind,
  allowed,
});

export const encodeClientMsg = (msg: ClientMsg): string => JSON.stringify(msg);

export const parseServerMsg = (data: string): ServerMsg => JSON.parse(data) as ServerMsg;
