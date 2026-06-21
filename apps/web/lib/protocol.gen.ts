// AUTO-GENERATED from apps/server/crates/protocol via ts-rs. Do not edit.
// Regenerate with: cargo test -p protocol

export type Brand = { name: string, image: string, };

export type EditOp = "place" | "break";

export type Role = "player" | "moderator" | "admin";

export type EditCell = { x: number, y: number, z: number, id: number, };

export type InventoryItem = { id: number, count: number, };

export type PlayerMeta = { id: number, name: string, skin: string, shirt: string, hair: string, };

export type PlayerState = [number, number, number, number, number, number, number, number, number];

export type CreatureState = [number, number, number, number, number, number, number, number];

export type PendingApproval = { account_id: string, name: string, email: string, };

export type ClientMsg = { "t": "join", tenant: string, world: string, name: string, skin: string, shirt: string, hair: string, claim: string, } | { "t": "move", x: number, y: number, z: number, yaw: number, pitch: number, } | { "t": "edit", op: EditOp, x: number, y: number, z: number, id: number, } | { "t": "pong", nonce: number, } | { "t": "chat", text: string, } | { "t": "hit", id: number, } | { "t": "edit_batch", edits: Array<EditCell>, } | { "t": "admin_set_peace", on: boolean, } | { "t": "admin_set_structure", kind: string, allowed: boolean, } | { "t": "admin_set_pvp", on: boolean, } | { "t": "admin_set_chat", on: boolean, } | { "t": "admin_set_infinite", on: boolean, } | { "t": "admin_kick", id: number, } | { "t": "admin_ban", id: number, } | { "t": "attack_player", id: number, } | { "t": "admin_reset_world" } | { "t": "admin_reset_scores" } | { "t": "admin_suspend", on: boolean, } | { "t": "admin_set_role", id: number, role: Role, } | { "t": "admin_set_approval", on: boolean, } | { "t": "admin_approve", account_id: string, } | { "t": "respawn" } | { "t": "dig", x: number, y: number, z: number, };

export type ServerMsg = { "t": "welcome", you: number, tenant: string, world: string, brand: Brand, tick_hz: number, spawn: [number, number, number], admin: boolean, moderator: boolean, 
/**
 * Server build identifier (GIT_SHA when deployed, else the crate version), shown in the debug panel.
 */
version: string, } | { "t": "snapshot", k: number, p: Array<PlayerState>, c: Array<CreatureState>, } | { "t": "edit", x: number, y: number, z: number, id: number, by: number, } | { "t": "edit_batch", edits: Array<EditCell>, by: number, } | { "t": "ping", nonce: number, } | { "t": "chat", from: number, name: string, text: string, } | { "t": "left", id: number, } | { "t": "error", code: string, msg: string, } | { "t": "event", kind: string, name: string, detail: string, } | { "t": "room_state", peace: boolean, blocked_structures: Array<string>, pvp: boolean, chat_enabled: boolean, suspended: boolean, approval_required: boolean, } | { "t": "pending_approvals", pending: Array<PendingApproval>, } | { "t": "hurt", by: string, } | { "t": "role", admin: boolean, moderator: boolean, } | { "t": "attack", kind: string, id: number, } | { "t": "respawn", x: number, y: number, z: number, hp: number, } | { "t": "inventory", items: Array<InventoryItem>, infinite: boolean, } | { "t": "roster", players: Array<PlayerMeta>, };

