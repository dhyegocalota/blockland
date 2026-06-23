import { describe, expect, it } from 'vitest';
import { lobbyModeGates, ModeBlockReason } from './lobby-modes';

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

  it('lets an admin pick online even when online is admin-disabled (so they can re-enable it)', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: false, offline_allowed: true },
      serverUnreachable: false,
      isAdmin: true,
    });
    expect(gates.online).toEqual({ disabled: false, reason: ModeBlockReason.Allowed });
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
});
