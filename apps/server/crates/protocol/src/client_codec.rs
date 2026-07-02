//! Binary codec for [`crate::ClientMsg`], the client→server input. Symmetric with the server→client
//! [`crate::snapshot_codec`]: a compact `1-byte tag + fields` frame instead of JSON text. The web client
//! encodes through the SAME Rust codec via the wasm `encode_client_msg` (no hand-written TS encoder), so
//! the two sides can never drift; the offline core decodes the same bytes. Cross-language hex fixtures
//! (below + `apps/web/lib/protocol.test.ts`) pin the bytes byte-for-byte.
//!
//! Byte layout (little-endian throughout): `[0]` is the variant tag (`TAG_*`), then the variant's fields
//! in declaration order. Field widths:
//!
//! ```text
//! string  u16 byte-length, then that many UTF-8 bytes
//! bool    u8 (0 | 1)
//! u8      1 byte             u32   4 bytes (le)         i32   4 bytes (le)
//! f32     4 bytes (le)       EditOp u8 (place=0,break=1) Role u8 (player=0,moderator=1,admin=2)
//! EditCell i32 x, i32 y, i32 z, u8 id
//! ```
//!
//! Move carries the client's raw position/yaw/pitch as full f32 (these are client inputs the anti-cheat
//! validates, NOT the centimetre-rounded snapshot coords — so they keep full precision, unlike the
//! snapshot codec). Every other field is its exact integer/bool/string.

use crate::{ClientMsg, EditCell, EditOp, Role};

/// Per-variant tag in byte 0. Stable wire identifiers — append new variants with a fresh value; never
/// renumber an existing one (a renumber silently mis-decodes an in-flight frame).
pub const TAG_JOIN: u8 = 0;
pub const TAG_MOVE: u8 = 1;
pub const TAG_EDIT: u8 = 2;
pub const TAG_PONG: u8 = 3;
pub const TAG_CHAT: u8 = 4;
pub const TAG_HIT: u8 = 5;
pub const TAG_EDIT_BATCH: u8 = 6;
pub const TAG_ADMIN_SET_PEACE: u8 = 7;
pub const TAG_ADMIN_SET_STRUCTURE: u8 = 8;
pub const TAG_ADMIN_SET_PVP: u8 = 9;
pub const TAG_ADMIN_SET_CHAT: u8 = 10;
pub const TAG_ADMIN_SET_INFINITE: u8 = 11;
pub const TAG_ADMIN_KICK: u8 = 12;
pub const TAG_ADMIN_BAN: u8 = 13;
pub const TAG_ATTACK_PLAYER: u8 = 14;
pub const TAG_ADMIN_RESET_WORLD: u8 = 15;
pub const TAG_ADMIN_RESET_SCORES: u8 = 16;
pub const TAG_ADMIN_SUSPEND: u8 = 17;
pub const TAG_ADMIN_SET_ROLE: u8 = 18;
pub const TAG_ADMIN_SET_APPROVAL: u8 = 19;
pub const TAG_ADMIN_APPROVE: u8 = 20;
pub const TAG_ADMIN_REJECT: u8 = 21;
pub const TAG_ADMIN_BAN_PENDING: u8 = 22;
pub const TAG_ADMIN_UNBAN: u8 = 23;
pub const TAG_ADMIN_SET_LIMITS: u8 = 24;
pub const TAG_ADMIN_SET_MODES: u8 = 25;
pub const TAG_RESPAWN: u8 = 26;
pub const TAG_DIG: u8 = 27;

/// EditOp on the wire (its declaration order in `crate::EditOp`).
const EDIT_OP_PLACE: u8 = 0;
const EDIT_OP_BREAK: u8 = 1;

/// Role on the wire (its declaration order in `crate::Role`).
const ROLE_PLAYER: u8 = 0;
const ROLE_MODERATOR: u8 = 1;
const ROLE_ADMIN: u8 = 2;

/// Why a client frame could not be decoded — surfaced to the caller (the server logs + drops the frame,
/// the wasm turns it into a JS error) rather than silently swallowed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientDecodeError {
    /// The tag byte matched no known `ClientMsg` variant — a decoder out of step with the encoder.
    UnknownTag(u8),
    /// The buffer ended mid-field (a truncated frame).
    Truncated,
    /// A string field was not valid UTF-8.
    InvalidUtf8,
    /// An enum field (EditOp / Role) carried a value outside its known set.
    InvalidEnum(u8),
}

impl std::fmt::Display for ClientDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientDecodeError::UnknownTag(t) => write!(f, "unknown client message tag {t}"),
            ClientDecodeError::Truncated => write!(f, "truncated client message"),
            ClientDecodeError::InvalidUtf8 => write!(f, "invalid utf-8 in client message"),
            ClientDecodeError::InvalidEnum(v) => {
                write!(f, "invalid enum value {v} in client message")
            }
        }
    }
}

impl std::error::Error for ClientDecodeError {}

struct Writer {
    bytes: Vec<u8>,
}

impl Writer {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    fn bool(&mut self, value: bool) {
        self.bytes.push(value as u8);
    }

    fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn i32(&mut self, value: i32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn f32(&mut self, value: f32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn string(&mut self, value: &str) {
        self.u16(value.len() as u16);
        self.bytes.extend_from_slice(value.as_bytes());
    }

    fn edit_op(&mut self, op: EditOp) {
        self.u8(match op {
            EditOp::Place => EDIT_OP_PLACE,
            EditOp::Break => EDIT_OP_BREAK,
        });
    }

    fn role(&mut self, role: Role) {
        self.u8(match role {
            Role::Player => ROLE_PLAYER,
            Role::Moderator => ROLE_MODERATOR,
            Role::Admin => ROLE_ADMIN,
        });
    }

    fn cell(&mut self, cell: &EditCell) {
        self.i32(cell.x);
        self.i32(cell.y);
        self.i32(cell.z);
        self.u8(cell.id);
    }
}

/// Encode one client message to its compact binary frame (tag byte + fields). The inverse of
/// [`decode_client_msg`]; the web client runs this same code via the wasm `encode_client_msg`.
pub fn encode_client_msg(msg: &ClientMsg) -> Vec<u8> {
    let mut w = Writer::new();
    match msg {
        ClientMsg::Join {
            tenant,
            world,
            name,
            skin,
            shirt,
            hair,
            claim,
            observer,
        } => {
            w.u8(TAG_JOIN);
            w.string(tenant);
            w.string(world);
            w.string(name);
            w.string(skin);
            w.string(shirt);
            w.string(hair);
            w.string(claim);
            w.bool(*observer);
        }
        ClientMsg::Move {
            x,
            y,
            z,
            yaw,
            pitch,
        } => {
            w.u8(TAG_MOVE);
            w.f32(*x);
            w.f32(*y);
            w.f32(*z);
            w.f32(*yaw);
            w.f32(*pitch);
        }
        ClientMsg::Edit { op, x, y, z, id } => {
            w.u8(TAG_EDIT);
            w.edit_op(*op);
            w.i32(*x);
            w.i32(*y);
            w.i32(*z);
            w.u8(*id);
        }
        ClientMsg::Pong { nonce } => {
            w.u8(TAG_PONG);
            w.u32(*nonce);
        }
        ClientMsg::Chat { text } => {
            w.u8(TAG_CHAT);
            w.string(text);
        }
        ClientMsg::Hit { id } => {
            w.u8(TAG_HIT);
            w.u32(*id);
        }
        ClientMsg::EditBatch { edits } => {
            w.u8(TAG_EDIT_BATCH);
            w.u16(edits.len() as u16);
            for cell in edits {
                w.cell(cell);
            }
        }
        ClientMsg::AdminSetPeace { on } => {
            w.u8(TAG_ADMIN_SET_PEACE);
            w.bool(*on);
        }
        ClientMsg::AdminSetStructure { kind, allowed } => {
            w.u8(TAG_ADMIN_SET_STRUCTURE);
            w.string(kind);
            w.bool(*allowed);
        }
        ClientMsg::AdminSetPvp { on } => {
            w.u8(TAG_ADMIN_SET_PVP);
            w.bool(*on);
        }
        ClientMsg::AdminSetChat { on } => {
            w.u8(TAG_ADMIN_SET_CHAT);
            w.bool(*on);
        }
        ClientMsg::AdminSetInfinite { on } => {
            w.u8(TAG_ADMIN_SET_INFINITE);
            w.bool(*on);
        }
        ClientMsg::AdminKick { id } => {
            w.u8(TAG_ADMIN_KICK);
            w.u32(*id);
        }
        ClientMsg::AdminBan { id } => {
            w.u8(TAG_ADMIN_BAN);
            w.u32(*id);
        }
        ClientMsg::AttackPlayer { id } => {
            w.u8(TAG_ATTACK_PLAYER);
            w.u32(*id);
        }
        ClientMsg::AdminResetWorld => {
            w.u8(TAG_ADMIN_RESET_WORLD);
        }
        ClientMsg::AdminResetScores => {
            w.u8(TAG_ADMIN_RESET_SCORES);
        }
        ClientMsg::AdminSuspend { on } => {
            w.u8(TAG_ADMIN_SUSPEND);
            w.bool(*on);
        }
        ClientMsg::AdminSetRole { id, role } => {
            w.u8(TAG_ADMIN_SET_ROLE);
            w.u32(*id);
            w.role(*role);
        }
        ClientMsg::AdminSetApproval { on } => {
            w.u8(TAG_ADMIN_SET_APPROVAL);
            w.bool(*on);
        }
        ClientMsg::AdminApprove { account_id } => {
            w.u8(TAG_ADMIN_APPROVE);
            w.string(account_id);
        }
        ClientMsg::AdminReject { account_id } => {
            w.u8(TAG_ADMIN_REJECT);
            w.string(account_id);
        }
        ClientMsg::AdminBanPending { account_id } => {
            w.u8(TAG_ADMIN_BAN_PENDING);
            w.string(account_id);
        }
        ClientMsg::AdminUnban { ip } => {
            w.u8(TAG_ADMIN_UNBAN);
            w.string(ip);
        }
        ClientMsg::AdminSetLimits {
            playtime_limit_min,
            playtime_window_h,
        } => {
            w.u8(TAG_ADMIN_SET_LIMITS);
            w.u32(*playtime_limit_min);
            w.u32(*playtime_window_h);
        }
        ClientMsg::AdminSetModes {
            online_allowed,
            offline_allowed,
        } => {
            w.u8(TAG_ADMIN_SET_MODES);
            w.bool(*online_allowed);
            w.bool(*offline_allowed);
        }
        ClientMsg::Respawn => {
            w.u8(TAG_RESPAWN);
        }
        ClientMsg::Dig { x, y, z } => {
            w.u8(TAG_DIG);
            w.i32(*x);
            w.i32(*y);
            w.i32(*z);
        }
    }
    w.bytes
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take<const N: usize>(&mut self) -> Result<[u8; N], ClientDecodeError> {
        let end = self.offset + N;
        if end > self.bytes.len() {
            return Err(ClientDecodeError::Truncated);
        }
        let chunk: [u8; N] = self.bytes[self.offset..end]
            .try_into()
            .expect("slice fits N");
        self.offset = end;
        Ok(chunk)
    }

    fn u8(&mut self) -> Result<u8, ClientDecodeError> {
        Ok(self.take::<1>()?[0])
    }

    fn bool(&mut self) -> Result<bool, ClientDecodeError> {
        Ok(self.u8()? != 0)
    }

    fn u16(&mut self) -> Result<u16, ClientDecodeError> {
        Ok(u16::from_le_bytes(self.take::<2>()?))
    }

    fn u32(&mut self) -> Result<u32, ClientDecodeError> {
        Ok(u32::from_le_bytes(self.take::<4>()?))
    }

    fn i32(&mut self) -> Result<i32, ClientDecodeError> {
        Ok(i32::from_le_bytes(self.take::<4>()?))
    }

    fn f32(&mut self) -> Result<f32, ClientDecodeError> {
        Ok(f32::from_le_bytes(self.take::<4>()?))
    }

    fn string(&mut self) -> Result<String, ClientDecodeError> {
        let len = self.u16()? as usize;
        let end = self.offset + len;
        if end > self.bytes.len() {
            return Err(ClientDecodeError::Truncated);
        }
        let text = std::str::from_utf8(&self.bytes[self.offset..end])
            .map_err(|_| ClientDecodeError::InvalidUtf8)?
            .to_string();
        self.offset = end;
        Ok(text)
    }

    fn edit_op(&mut self) -> Result<EditOp, ClientDecodeError> {
        match self.u8()? {
            EDIT_OP_PLACE => Ok(EditOp::Place),
            EDIT_OP_BREAK => Ok(EditOp::Break),
            other => Err(ClientDecodeError::InvalidEnum(other)),
        }
    }

    fn role(&mut self) -> Result<Role, ClientDecodeError> {
        match self.u8()? {
            ROLE_PLAYER => Ok(Role::Player),
            ROLE_MODERATOR => Ok(Role::Moderator),
            ROLE_ADMIN => Ok(Role::Admin),
            other => Err(ClientDecodeError::InvalidEnum(other)),
        }
    }

    fn cell(&mut self) -> Result<EditCell, ClientDecodeError> {
        Ok(EditCell {
            x: self.i32()?,
            y: self.i32()?,
            z: self.i32()?,
            id: self.u8()?,
        })
    }

    fn cells(&mut self) -> Result<Vec<EditCell>, ClientDecodeError> {
        let count = self.u16()?;
        (0..count).map(|_| self.cell()).collect()
    }
}

/// Decode one binary client frame back into a typed [`ClientMsg`] — the inverse of [`encode_client_msg`].
/// The server (both the Join handshake and the per-message loop) and the offline core run this. A bad tag,
/// truncation, bad UTF-8 or an out-of-range enum surfaces a typed [`ClientDecodeError`] rather than a misread.
pub fn decode_client_msg(bytes: &[u8]) -> Result<ClientMsg, ClientDecodeError> {
    let mut r = Reader::new(bytes);
    let tag = r.u8()?;
    let msg = match tag {
        TAG_JOIN => ClientMsg::Join {
            tenant: r.string()?,
            world: r.string()?,
            name: r.string()?,
            skin: r.string()?,
            shirt: r.string()?,
            hair: r.string()?,
            claim: r.string()?,
            // Trailing flag: absent from a pre-observer client's frame, which decodes as a normal
            // playing join (false) so an in-flight old client is never rejected during a rollout.
            observer: r.bool().unwrap_or(false),
        },
        TAG_MOVE => ClientMsg::Move {
            x: r.f32()?,
            y: r.f32()?,
            z: r.f32()?,
            yaw: r.f32()?,
            pitch: r.f32()?,
        },
        TAG_EDIT => ClientMsg::Edit {
            op: r.edit_op()?,
            x: r.i32()?,
            y: r.i32()?,
            z: r.i32()?,
            id: r.u8()?,
        },
        TAG_PONG => ClientMsg::Pong { nonce: r.u32()? },
        TAG_CHAT => ClientMsg::Chat { text: r.string()? },
        TAG_HIT => ClientMsg::Hit { id: r.u32()? },
        TAG_EDIT_BATCH => ClientMsg::EditBatch { edits: r.cells()? },
        TAG_ADMIN_SET_PEACE => ClientMsg::AdminSetPeace { on: r.bool()? },
        TAG_ADMIN_SET_STRUCTURE => ClientMsg::AdminSetStructure {
            kind: r.string()?,
            allowed: r.bool()?,
        },
        TAG_ADMIN_SET_PVP => ClientMsg::AdminSetPvp { on: r.bool()? },
        TAG_ADMIN_SET_CHAT => ClientMsg::AdminSetChat { on: r.bool()? },
        TAG_ADMIN_SET_INFINITE => ClientMsg::AdminSetInfinite { on: r.bool()? },
        TAG_ADMIN_KICK => ClientMsg::AdminKick { id: r.u32()? },
        TAG_ADMIN_BAN => ClientMsg::AdminBan { id: r.u32()? },
        TAG_ATTACK_PLAYER => ClientMsg::AttackPlayer { id: r.u32()? },
        TAG_ADMIN_RESET_WORLD => ClientMsg::AdminResetWorld,
        TAG_ADMIN_RESET_SCORES => ClientMsg::AdminResetScores,
        TAG_ADMIN_SUSPEND => ClientMsg::AdminSuspend { on: r.bool()? },
        TAG_ADMIN_SET_ROLE => ClientMsg::AdminSetRole {
            id: r.u32()?,
            role: r.role()?,
        },
        TAG_ADMIN_SET_APPROVAL => ClientMsg::AdminSetApproval { on: r.bool()? },
        TAG_ADMIN_APPROVE => ClientMsg::AdminApprove {
            account_id: r.string()?,
        },
        TAG_ADMIN_REJECT => ClientMsg::AdminReject {
            account_id: r.string()?,
        },
        TAG_ADMIN_BAN_PENDING => ClientMsg::AdminBanPending {
            account_id: r.string()?,
        },
        TAG_ADMIN_UNBAN => ClientMsg::AdminUnban { ip: r.string()? },
        TAG_ADMIN_SET_LIMITS => ClientMsg::AdminSetLimits {
            playtime_limit_min: r.u32()?,
            playtime_window_h: r.u32()?,
        },
        TAG_ADMIN_SET_MODES => ClientMsg::AdminSetModes {
            online_allowed: r.bool()?,
            offline_allowed: r.bool()?,
        },
        TAG_RESPAWN => ClientMsg::Respawn,
        TAG_DIG => ClientMsg::Dig {
            x: r.i32()?,
            y: r.i32()?,
            z: r.i32()?,
        },
        other => return Err(ClientDecodeError::UnknownTag(other)),
    };
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// One representative value of EVERY `ClientMsg` variant. Each round-trips through encode→decode, and
    /// the representative Move/Edit/Join/Chat bytes below are pinned as cross-language fixtures.
    fn every_variant() -> Vec<ClientMsg> {
        vec![
            ClientMsg::Join {
                tenant: "acme".into(),
                world: "main".into(),
                name: "Bo".into(),
                skin: "#f2c18b".into(),
                shirt: "#ff5d2e".into(),
                hair: "#3a2a1a".into(),
                claim: "tok".into(),
                observer: false,
            },
            ClientMsg::Move {
                x: 1.5,
                y: 2.25,
                z: -8.0,
                yaw: 0.31,
                pitch: -0.05,
            },
            ClientMsg::Edit {
                op: EditOp::Place,
                x: 10,
                y: -3,
                z: 7,
                id: 4,
            },
            ClientMsg::Pong { nonce: 42 },
            ClientMsg::Chat {
                text: "hi there".into(),
            },
            ClientMsg::Hit { id: 7 },
            ClientMsg::EditBatch {
                edits: vec![
                    EditCell {
                        x: 1,
                        y: 2,
                        z: 3,
                        id: 5,
                    },
                    EditCell {
                        x: -4,
                        y: 0,
                        z: 9,
                        id: 0,
                    },
                ],
            },
            ClientMsg::AdminSetPeace { on: true },
            ClientMsg::AdminSetStructure {
                kind: "cola".into(),
                allowed: false,
            },
            ClientMsg::AdminSetPvp { on: false },
            ClientMsg::AdminSetChat { on: true },
            ClientMsg::AdminSetInfinite { on: true },
            ClientMsg::AdminKick { id: 3 },
            ClientMsg::AdminBan { id: 4 },
            ClientMsg::AttackPlayer { id: 5 },
            ClientMsg::AdminResetWorld,
            ClientMsg::AdminResetScores,
            ClientMsg::AdminSuspend { on: true },
            ClientMsg::AdminSetRole {
                id: 9,
                role: Role::Moderator,
            },
            ClientMsg::AdminSetApproval { on: false },
            ClientMsg::AdminApprove {
                account_id: "acc1".into(),
            },
            ClientMsg::AdminReject {
                account_id: "acc2".into(),
            },
            ClientMsg::AdminBanPending {
                account_id: "ip:1.2.3.4".into(),
            },
            ClientMsg::AdminUnban {
                ip: "1.2.3.4".into(),
            },
            ClientMsg::AdminSetLimits {
                playtime_limit_min: 30,
                playtime_window_h: 24,
            },
            ClientMsg::AdminSetModes {
                online_allowed: true,
                offline_allowed: false,
            },
            ClientMsg::Respawn,
            ClientMsg::Dig {
                x: -1,
                y: 64,
                z: 200,
            },
        ]
    }

    /// EVERY variant survives encode→decode unchanged.
    #[test]
    fn every_variant_round_trips() {
        for msg in every_variant() {
            let bytes = encode_client_msg(&msg);
            let back = decode_client_msg(&bytes).expect("decodes");
            assert_eq!(back, msg, "variant did not round-trip");
        }
    }

    /// Each variant's tag must be distinct, or two variants would mis-decode as each other.
    #[test]
    fn every_variant_has_a_distinct_first_byte() {
        let mut tags: Vec<u8> = every_variant()
            .iter()
            .map(|m| encode_client_msg(m)[0])
            .collect();
        let count = tags.len();
        tags.sort_unstable();
        tags.dedup();
        assert_eq!(tags.len(), count, "duplicate tag byte across variants");
    }

    /// A truncated frame, an unknown tag, and a bad enum value each surface a typed error (not a misread).
    #[test]
    fn rejects_truncated_unknown_tag_and_bad_enum() {
        assert_eq!(decode_client_msg(&[]), Err(ClientDecodeError::Truncated));
        // TAG_MOVE then only 3 bytes where 20 (5×f32) are needed.
        assert_eq!(
            decode_client_msg(&[TAG_MOVE, 0, 0, 0]),
            Err(ClientDecodeError::Truncated)
        );
        assert_eq!(
            decode_client_msg(&[200]),
            Err(ClientDecodeError::UnknownTag(200))
        );
        // TAG_EDIT then an EditOp of 9 (neither place=0 nor break=1).
        assert_eq!(
            decode_client_msg(&[TAG_EDIT, 9]),
            Err(ClientDecodeError::InvalidEnum(9))
        );
    }

    /// The cross-language safety net: these EXACT hex strings are pasted into `apps/web/lib/protocol.test.ts`,
    /// which encodes the same messages through the wasm `encode_client_msg` and asserts identical bytes, and
    /// decodes them back. If any hex here changes, update the TS fixture to match (and vice versa).
    #[test]
    fn encodes_representative_messages_to_exact_bytes() {
        let move_msg = ClientMsg::Move {
            x: 1.5,
            y: 2.25,
            z: -8.0,
            yaw: 0.31,
            pitch: -0.05,
        };
        assert_eq!(to_hex(&encode_client_msg(&move_msg)), MOVE_FIXTURE_HEX);

        let edit_msg = ClientMsg::Edit {
            op: EditOp::Place,
            x: 10,
            y: -3,
            z: 7,
            id: 4,
        };
        assert_eq!(to_hex(&encode_client_msg(&edit_msg)), EDIT_FIXTURE_HEX);

        let join_msg = ClientMsg::Join {
            tenant: "acme".into(),
            world: "main".into(),
            name: "Bo".into(),
            skin: "#f2c18b".into(),
            shirt: "#ff5d2e".into(),
            hair: "#3a2a1a".into(),
            claim: "tok".into(),
            observer: false,
        };
        assert_eq!(to_hex(&encode_client_msg(&join_msg)), JOIN_FIXTURE_HEX);

        let chat_msg = ClientMsg::Chat {
            text: "hi there".into(),
        };
        assert_eq!(to_hex(&encode_client_msg(&chat_msg)), CHAT_FIXTURE_HEX);

        let pong_msg = ClientMsg::Pong { nonce: 42 };
        assert_eq!(to_hex(&encode_client_msg(&pong_msg)), PONG_FIXTURE_HEX);
    }

    /// Pinned exact bytes, computed by the encoder itself. Mirrored in `apps/web/lib/protocol.test.ts`.
    /// MOVE: tag 01, then f32 le for 1.5, 2.25, -8.0, 0.31, -0.05.
    const MOVE_FIXTURE_HEX: &str = "010000c03f00001040000000c152b89e3ecdcc4cbd";
    /// EDIT: tag 02, EditOp place 00, i32 le x=10, y=-3, z=7, id=04.
    const EDIT_FIXTURE_HEX: &str = "02000a000000fdffffff0700000004";
    /// JOIN: tag 00, then 7 length-prefixed strings (tenant/world/name/skin/shirt/hair/claim), then the
    /// observer bool (00 = a normal playing join).
    const JOIN_FIXTURE_HEX: &str =
        "00040061636d6504006d61696e0200426f0700236632633138620700236666356432650700233361326131610300746f6b00";
    /// CHAT: tag 04, u16 len 8, "hi there".
    const CHAT_FIXTURE_HEX: &str = "0408006869207468657265";
    /// PONG: tag 03, u32 le nonce 42.
    const PONG_FIXTURE_HEX: &str = "032a000000";
}
