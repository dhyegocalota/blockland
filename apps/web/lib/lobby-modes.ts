// Pure lobby mode-gating: given a tenant's allowed modes and whether the game server is reachable,
// decide whether each start button (online "with friends" / offline "solo") is disabled and why.
// ONLINE-blocking is also enforced server-side (the join is rejected); OFFLINE can only be enforced
// here, on the client, because an offline game never reaches the server.

import type { Tenant } from './builtins';

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
// An admin bypasses an admin-disabled mode (mirrors the server, which still admits an admin to an
// online-blocked world — room.rs) so they can always pick a mode and re-enable it from the panel;
// an unreachable server still blocks online for everyone, admin included.
export function lobbyModeGates({
  tenant,
  serverUnreachable,
  isAdmin,
}: {
  tenant: Pick<Tenant, 'online_allowed' | 'offline_allowed'>;
  serverUnreachable: boolean;
  isAdmin: boolean;
}): LobbyModeGates {
  const onlineReason = onlineBlockReason({ allowed: tenant.online_allowed, serverUnreachable, isAdmin });
  const offlineReason = tenant.offline_allowed || isAdmin ? ModeBlockReason.Allowed : ModeBlockReason.AdminDisabled;
  return {
    online: { disabled: onlineReason !== ModeBlockReason.Allowed, reason: onlineReason },
    offline: { disabled: offlineReason !== ModeBlockReason.Allowed, reason: offlineReason },
  };
}

function onlineBlockReason({
  allowed,
  serverUnreachable,
  isAdmin,
}: {
  allowed: boolean;
  serverUnreachable: boolean;
  isAdmin: boolean;
}): ModeBlockReason {
  if (serverUnreachable) return ModeBlockReason.Unreachable;
  if (!allowed && !isAdmin) return ModeBlockReason.AdminDisabled;
  return ModeBlockReason.Allowed;
}
