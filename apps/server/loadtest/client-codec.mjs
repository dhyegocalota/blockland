// Minimal binary client-message encoder for the load harness — a JS mirror of
// `apps/server/crates/protocol/src/client_codec.rs`. The bots now send the SAME compact binary
// `ClientMsg` frames the web client sends (the server only accepts binary input), so each bot encodes
// its join/move/dig/edit/hit/attack/chat/pong through this. The byte layout is asserted byte-for-byte
// against the Rust encoder by the cross-language hex fixtures (see protocol.test.ts / client_codec.rs).

const TAG = {
  join: 0,
  move: 1,
  edit: 2,
  pong: 3,
  chat: 4,
  hit: 5,
  edit_batch: 6,
  admin_set_peace: 7,
  admin_set_structure: 8,
  admin_set_pvp: 9,
  admin_set_chat: 10,
  admin_set_infinite: 11,
  admin_kick: 12,
  admin_ban: 13,
  attack_player: 14,
  admin_reset_world: 15,
  admin_reset_scores: 16,
  admin_suspend: 17,
  admin_set_role: 18,
  admin_set_approval: 19,
  admin_approve: 20,
  admin_reject: 21,
  admin_ban_pending: 22,
  admin_unban: 23,
  admin_set_limits: 24,
  admin_set_modes: 25,
  respawn: 26,
  dig: 27,
};

const EDIT_OP = { place: 0, break: 1 };
const ROLE = { player: 0, moderator: 1, admin: 2 };

class Writer {
  constructor() {
    this.bytes = [];
  }

  u8(value) {
    this.bytes.push(value & 0xff);
  }

  bool(value) {
    this.bytes.push(value ? 1 : 0);
  }

  u16(value) {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
  }

  u32(value) {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value >>> 0, true);
    this.push(view);
  }

  i32(value) {
    const view = new DataView(new ArrayBuffer(4));
    view.setInt32(0, value | 0, true);
    this.push(view);
  }

  f32(value) {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    this.push(view);
  }

  string(value) {
    const utf8 = new TextEncoder().encode(value);
    this.u16(utf8.length);
    for (const byte of utf8) this.bytes.push(byte);
  }

  cell(cell) {
    this.i32(cell.x);
    this.i32(cell.y);
    this.i32(cell.z);
    this.u8(cell.id);
  }

  push(view) {
    for (let i = 0; i < view.byteLength; i += 1) this.bytes.push(view.getUint8(i));
  }

  done() {
    return Uint8Array.from(this.bytes);
  }
}

// Encode one client message (the same `{ t, ... }` object the web factories build) to its binary frame.
// Throws on an unknown `t`, so a typo surfaces loudly rather than sending a silent empty frame.
export function encodeClientMsg(msg) {
  const w = new Writer();
  const tag = TAG[msg.t];
  if (tag === undefined) throw new Error(`unknown client message type ${msg.t}`);
  w.u8(tag);
  if (msg.t === 'join') {
    w.string(msg.tenant);
    w.string(msg.world);
    w.string(msg.name);
    w.string(msg.skin);
    w.string(msg.shirt);
    w.string(msg.hair);
    w.string(msg.claim);
  } else if (msg.t === 'move') {
    w.f32(msg.x);
    w.f32(msg.y);
    w.f32(msg.z);
    w.f32(msg.yaw);
    w.f32(msg.pitch);
  } else if (msg.t === 'edit') {
    w.u8(EDIT_OP[msg.op]);
    w.i32(msg.x);
    w.i32(msg.y);
    w.i32(msg.z);
    w.u8(msg.id);
  } else if (msg.t === 'pong') {
    w.u32(msg.nonce);
  } else if (msg.t === 'chat') {
    w.string(msg.text);
  } else if (msg.t === 'hit') {
    w.u32(msg.id);
  } else if (msg.t === 'edit_batch') {
    w.u16(msg.edits.length);
    for (const cell of msg.edits) w.cell(cell);
  } else if (msg.t === 'admin_set_peace') {
    w.bool(msg.on);
  } else if (msg.t === 'admin_set_structure') {
    w.string(msg.kind);
    w.bool(msg.allowed);
  } else if (msg.t === 'admin_set_pvp') {
    w.bool(msg.on);
  } else if (msg.t === 'admin_set_chat') {
    w.bool(msg.on);
  } else if (msg.t === 'admin_set_infinite') {
    w.bool(msg.on);
  } else if (msg.t === 'admin_kick') {
    w.u32(msg.id);
  } else if (msg.t === 'admin_ban') {
    w.u32(msg.id);
  } else if (msg.t === 'attack_player') {
    w.u32(msg.id);
  } else if (msg.t === 'admin_suspend') {
    w.bool(msg.on);
  } else if (msg.t === 'admin_set_role') {
    w.u32(msg.id);
    w.u8(ROLE[msg.role]);
  } else if (msg.t === 'admin_set_approval') {
    w.bool(msg.on);
  } else if (msg.t === 'admin_approve') {
    w.string(msg.account_id);
  } else if (msg.t === 'admin_reject') {
    w.string(msg.account_id);
  } else if (msg.t === 'admin_ban_pending') {
    w.string(msg.account_id);
  } else if (msg.t === 'admin_unban') {
    w.string(msg.ip);
  } else if (msg.t === 'admin_set_limits') {
    w.u32(msg.playtime_limit_min);
    w.u32(msg.playtime_window_h);
  } else if (msg.t === 'admin_set_modes') {
    w.bool(msg.online_allowed);
    w.bool(msg.offline_allowed);
  } else if (msg.t === 'dig') {
    w.i32(msg.x);
    w.i32(msg.y);
    w.i32(msg.z);
  }
  // respawn / admin_reset_world / admin_reset_scores carry no fields (just the tag).
  return w.done();
}
