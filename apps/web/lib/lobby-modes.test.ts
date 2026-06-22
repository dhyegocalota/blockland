import { describe, expect, it } from 'vitest';
import { lobbyModeGates, ModeBlockReason } from './lobby-modes';

describe('lobbyModeGates', () => {
  it('allows both modes when the tenant allows both and the server is reachable', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: true, offline_allowed: true },
      serverUnreachable: false,
    });
    expect(gates.online).toEqual({ disabled: false, reason: ModeBlockReason.Allowed });
    expect(gates.offline).toEqual({ disabled: false, reason: ModeBlockReason.Allowed });
  });

  it('disables online when the tenant admin blocked it', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: false, offline_allowed: true },
      serverUnreachable: false,
    });
    expect(gates.online).toEqual({ disabled: true, reason: ModeBlockReason.AdminDisabled });
    expect(gates.offline.disabled).toBe(false);
  });

  it('disables offline when the tenant admin blocked it', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: true, offline_allowed: false },
      serverUnreachable: false,
    });
    expect(gates.offline).toEqual({ disabled: true, reason: ModeBlockReason.AdminDisabled });
    expect(gates.online.disabled).toBe(false);
  });

  it('disables online as unreachable when the server is down, even if the tenant allows it', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: true, offline_allowed: true },
      serverUnreachable: true,
    });
    expect(gates.online).toEqual({ disabled: true, reason: ModeBlockReason.Unreachable });
    expect(gates.offline.disabled).toBe(false);
  });

  it('prefers the unreachable reason over an admin block when both apply to online', () => {
    const gates = lobbyModeGates({
      tenant: { online_allowed: false, offline_allowed: true },
      serverUnreachable: true,
    });
    expect(gates.online.reason).toBe(ModeBlockReason.Unreachable);
  });
});
