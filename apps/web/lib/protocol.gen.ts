// AUTO-GENERATED from apps/server/crates/protocol via ts-rs. Do not edit.
// Regenerate with: cargo test -p protocol

export type Brand = { name: string, primary: string, logo: string | null, };

export type EditOp = "place" | "break";

export type EditCell = { x: number, y: number, z: number, id: number, };

export type PlayerState = { id: number, name: string, skin: string, shirt: string, hair: string, x: number, y: number, z: number, yaw: number, pitch: number, ping_ms: number, };

export type ClientMsg = { "t": "join", tenant: string, world: string, name: string, skin: string, shirt: string, hair: string, } | { "t": "move", x: number, y: number, z: number, yaw: number, pitch: number, } | { "t": "edit", op: EditOp, x: number, y: number, z: number, id: number, } | { "t": "pong", nonce: number, } | { "t": "chat", text: string, } | { "t": "edit_batch", edits: Array<EditCell>, };

export type ServerMsg = { "t": "welcome", you: number, tenant: string, world: string, brand: Brand, tick_hz: number, spawn: [number, number, number], } | { "t": "snapshot", tick: number, players: Array<PlayerState>, } | { "t": "edit", x: number, y: number, z: number, id: number, by: number, } | { "t": "edit_batch", edits: Array<EditCell>, by: number, } | { "t": "ping", nonce: number, } | { "t": "chat", from: number, name: string, text: string, } | { "t": "left", id: number, } | { "t": "error", code: string, msg: string, };

