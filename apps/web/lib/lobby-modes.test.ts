import { describe, expect, it } from 'vitest';
import {
  lobbyAdminPanelActive, lobbyBlockBanner, lobbyModeGates, LobbyBlockKind, ModeBlockReason,
  shouldPushToOnline, shouldPushToSolo, type LobbyModeGates,
} from './lobby-modes';

const ALLOWED = { disabled: false, reason: ModeBlockReason.Allowed };
function gatesWith({ online, offline }: { online: boolean; offline: boolean }): LobbyModeGates {
  return {
    online: online ? { disabled: true, reason: ModeBlockReason.AdminDisabled } : ALLOWED,
    offline: offline ? { disabled: true, reason: ModeBlockReason.AdminDisabled } : ALLOWED,
  };
}

describe('lobbyModeGates', () => {
  it('allows both modes when the tenant allows both and the server is reachable', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: true, offline_allowed: true },
      serverUnreachable: false,
      isAdmin: false,
    });
    expect(gates.online).toEqual({ disabled: false, reason: ModeBlockReason.Allowed });
    expect(gates.offline).toEqual({ disabled: false, reason: ModeBlockReason.Allowed });
  });

  it('disables online when the tenant admin blocked it', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: false, offline_allowed: true },
      serverUnreachable: false,
      isAdmin: false,
    });
    expect(gates.online).toEqual({ disabled: true, reason: ModeBlockReason.AdminDisabled });
    expect(gates.offline.disabled).toBe(false);
  });

  it('disables offline when the tenant admin blocked it', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: true, offline_allowed: false },
      serverUnreachable: false,
      isAdmin: false,
    });
    expect(gates.offline).toEqual({ disabled: true, reason: ModeBlockReason.AdminDisabled });
    expect(gates.online.disabled).toBe(false);
  });

  it('disables online as unreachable when the server is down, even if the tenant allows it', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: true, offline_allowed: true },
      serverUnreachable: true,
      isAdmin: false,
    });
    expect(gates.online).toEqual({ disabled: true, reason: ModeBlockReason.Unreachable });
    expect(gates.offline.disabled).toBe(false);
  });

  it('prefers the unreachable reason over an admin block when both apply to online', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: false, offline_allowed: true },
      serverUnreachable: true,
      isAdmin: false,
    });
    expect(gates.online.reason).toBe(ModeBlockReason.Unreachable);
  });

  it('blocks an admin from picking online when online is admin-disabled (re-enable via the panel, not by playing)', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: false, offline_allowed: true },
      serverUnreachable: false,
      isAdmin: true,
    });
    expect(gates.online).toEqual({ disabled: true, reason: ModeBlockReason.AdminDisabled });
  });

  it('lets an admin pick offline even when offline is admin-disabled', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: true, offline_allowed: false },
      serverUnreachable: false,
      isAdmin: true,
    });
    expect(gates.offline).toEqual({ disabled: false, reason: ModeBlockReason.Allowed });
  });

  it('still blocks an admin from online when the server is unreachable', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: true, offline_allowed: true },
      serverUnreachable: true,
      isAdmin: true,
    });
    expect(gates.online).toEqual({ disabled: true, reason: ModeBlockReason.Unreachable });
  });

  it('keeps the panel up and does not push an admin to solo when online is admin-disabled', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: false, offline_allowed: true },
      serverUnreachable: false,
      isAdmin: true,
    });
    expect(gates.online.disabled).toBe(true);
    expect(lobbyAdminPanelActive({ isLobbyAdmin: true, started: false })).toBe(true);
    expect(shouldPushToSolo({ gates, alreadySolo: false, isLobbyAdmin: true })).toBe(false);
  });
});

describe('lobbyAdminPanelActive', () => {
  it('stays active for a lobby admin until the game starts', () => {
    expect(lobbyAdminPanelActive({ isLobbyAdmin: true, started: false })).toBe(true);
  });

  it('drops once the game has started', () => {
    expect(lobbyAdminPanelActive({ isLobbyAdmin: true, started: true })).toBe(false);
  });

  it('is never active for a non-admin', () => {
    expect(lobbyAdminPanelActive({ isLobbyAdmin: false, started: false })).toBe(false);
  });
});

describe('shouldPushToSolo', () => {
  it('pushes a non-admin to solo when online is blocked and offline is allowed', () => {
    const gates = gatesWith({ online: true, offline: false });
    expect(shouldPushToSolo({ gates, alreadySolo: false, isLobbyAdmin: false })).toBe(true);
  });

  it('never pushes a lobby admin to solo even when online is blocked', () => {
    const gates = gatesWith({ online: true, offline: false });
    expect(shouldPushToSolo({ gates, alreadySolo: false, isLobbyAdmin: true })).toBe(false);
  });

  it('does not push when already solo', () => {
    const gates = gatesWith({ online: true, offline: false });
    expect(shouldPushToSolo({ gates, alreadySolo: true, isLobbyAdmin: false })).toBe(false);
  });
});

describe('shouldPushToOnline', () => {
  it('pulls a solo non-admin back to online when offline is blocked and online is allowed', () => {
    const gates = gatesWith({ online: false, offline: true });
    expect(shouldPushToOnline({ gates, alreadySolo: true, isLobbyAdmin: false })).toBe(true);
  });

  it('never moves a lobby admin', () => {
    const gates = gatesWith({ online: false, offline: true });
    expect(shouldPushToOnline({ gates, alreadySolo: true, isLobbyAdmin: true })).toBe(false);
  });
});

describe('lobbyBlockBanner', () => {
  it('flags the time-up banner when the join was rejected for spent play time', () => {
    expect(lobbyBlockBanner({ netState: 'time_up', suspended: false })).toEqual({
      kind: LobbyBlockKind.TimeUp,
      key: 'lobby.block_time_up',
    });
  });

  it('flags the paused banner when a join hits a suspended world (room_closed)', () => {
    expect(lobbyBlockBanner({ netState: 'room_closed', suspended: false })).toEqual({
      kind: LobbyBlockKind.Paused,
      key: 'lobby.block_paused',
    });
  });

  it('flags the paused banner from the live lobby-admin suspended flag', () => {
    expect(lobbyBlockBanner({ netState: null, suspended: true })).toEqual({
      kind: LobbyBlockKind.Paused,
      key: 'lobby.block_paused',
    });
  });

  it('returns null on a normal lobby with nothing blocking', () => {
    expect(lobbyBlockBanner({ netState: null, suspended: false })).toBeNull();
    expect(lobbyBlockBanner({ netState: 'online', suspended: false })).toBeNull();
  });
});
