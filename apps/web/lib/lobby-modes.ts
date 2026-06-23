// Pure lobby mode-gating: given a tenant's allowed modes and whether the game server is reachable,
// decide whether each start button (online "with friends" / offline "solo") is disabled and why.
// ONLINE-blocking is also enforced server-side (the join is rejected); OFFLINE can only be enforced
// here, on the client, because an offline game never reaches the server.

import type { Tenant } from './builtins';
import type { NetState } from './net';

export enum ModeBlockReason {
  Allowed = 'allowed',
  // The server is unreachable, so online play is impossible right now (solo is forced).
  Unreachable = 'unreachable',
  // The tenant's admin turned this mode off.
  AdminDisabled = 'admin_disabled',
}

export interface ModeGate {
  disabled: boolean;
  reason: ModeBlockReason;
}

export interface LobbyModeGates {
  online: ModeGate;
  offline: ModeGate;
}

// `offline` here means the game server is unreachable (the lobby fell back to the bundled tenant).
// When online is admin-disabled NOBODY may pick online to PLAY — admin and moderator included; the
// admin re-enables it from the lobby admin panel (a management connection the server still admits via
// room.rs), not by starting an online game. An admin still bypasses an admin-disabled OFFLINE mode so
// they can always reach a playable mode. An unreachable server blocks online for everyone, admin too.
export function lobbyModeGates({
  tenant,
  serverUnreachable,
  isAdmin,
}: {
  tenant: Pick<Tenant, 'online_allowed' | 'offline_allowed'>;
  serverUnreachable: boolean;
  isAdmin: boolean;
}): LobbyModeGates {
  const onlineReason = onlineBlockReason({ allowed: tenant.online_allowed, serverUnreachable });
  const offlineReason = tenant.offline_allowed || isAdmin ? ModeBlockReason.Allowed : ModeBlockReason.AdminDisabled;
  return {
    online: { disabled: onlineReason !== ModeBlockReason.Allowed, reason: onlineReason },
    offline: { disabled: offlineReason !== ModeBlockReason.Allowed, reason: offlineReason },
  };
}

function onlineBlockReason({
  allowed,
  serverUnreachable,
}: {
  allowed: boolean;
  serverUnreachable: boolean;
}): ModeBlockReason {
  if (serverUnreachable) return ModeBlockReason.Unreachable;
  if (!allowed) return ModeBlockReason.AdminDisabled;
  return ModeBlockReason.Allowed;
}

// Whether the headless lobby-admin connection (and its panel) should stay live: a logged-in
// admin/moderator keeps it on the start screen until the game actually starts, regardless of which
// modes the tenant disabled — they need the panel to re-enable a mode or change other settings, and
// dropping the connection would blank the live config the panel edits.
export function lobbyAdminPanelActive({
  isLobbyAdmin,
  started,
}: {
  isLobbyAdmin: boolean;
  started: boolean;
}): boolean {
  return isLobbyAdmin && !started;
}

// The lobby auto-push that keeps a player's chosen mode valid must never move a lobby admin/moderator:
// forcing them to solo would tear down the lobby-admin connection that powers the panel they use to
// re-enable a disabled mode. A non-admin is still pushed to the only mode the tenant allows.
export function shouldPushToSolo({
  gates,
  alreadySolo,
  isLobbyAdmin,
}: {
  gates: LobbyModeGates;
  alreadySolo: boolean;
  isLobbyAdmin: boolean;
}): boolean {
  if (isLobbyAdmin) return false;
  return gates.online.disabled && !gates.offline.disabled && !alreadySolo;
}

export function shouldPushToOnline({
  gates,
  alreadySolo,
  isLobbyAdmin,
}: {
  gates: LobbyModeGates;
  alreadySolo: boolean;
  isLobbyAdmin: boolean;
}): boolean {
  if (isLobbyAdmin) return false;
  return gates.offline.disabled && !gates.online.disabled && alreadySolo;
}

// Why the lobby is blocking the player from starting a game, surfaced as a big banner on the start
// screen. `TimeUp` is the play-time budget being spent (server rejects the join with `time_up`);
// `Paused` is the world being suspended by an admin (a normal player's join is rejected with the
// `suspended`→`room_closed` terminal state; an admin/moderator sees it proactively via the live
// lobby-admin `room.suspended`). Returns null when nothing is blocking.
export enum LobbyBlockKind {
  TimeUp = 'time_up',
  Paused = 'paused',
}

export interface LobbyBlock {
  kind: LobbyBlockKind;
  key: string;
}

const LOBBY_BLOCK_KEYS: Record<LobbyBlockKind, string> = {
  [LobbyBlockKind.TimeUp]: 'lobby.block_time_up',
  [LobbyBlockKind.Paused]: 'lobby.block_paused',
};

export function lobbyBlockBanner({
  netState,
  suspended,
}: {
  netState: NetState | null;
  suspended: boolean;
}): LobbyBlock | null {
  if (netState === 'time_up') return { kind: LobbyBlockKind.TimeUp, key: LOBBY_BLOCK_KEYS[LobbyBlockKind.TimeUp] };
  if (netState === 'room_closed' || suspended) return { kind: LobbyBlockKind.Paused, key: LOBBY_BLOCK_KEYS[LobbyBlockKind.Paused] };
  return null;
}
