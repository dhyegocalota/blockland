import { describe, expect, it, vi } from 'vitest';
import { createOfflineMode } from './offline-mode';
import type { GameRuntime } from '../runtime';
import type { RoomState } from '../../coop';

function makeRuntime(creatureCount: number, initialRoom: RoomState | null = null) {
  const onRole = vi.fn();
  const onRoomState = vi.fn();
  const populateCreatures = vi.fn();
  const applyRoomState = vi.fn();
  const resolveInitialRoom = vi.fn(() => initialRoom);
  const room: RoomState = { suspended: false } as unknown as RoomState;
  const runtime = {
    bridge: { hud: { onRole, onRoomState }, resolveInitialRoom },
    creatures: new Array(creatureCount).fill(0),
    populateCreatures,
    applyRoomState,
    currentRoom: () => room,
  } as unknown as GameRuntime;
  createOfflineMode(runtime);
  return { runtime, onRole, onRoomState, populateCreatures, applyRoomState, resolveInitialRoom };
}

const LOBBY_ROOM: RoomState = {
  peace: false, blockedStructures: ['tower'], pvp: true, chatEnabled: false, suspended: false,
  approvalRequired: true, playtimeLimitMin: 5, playtimeWindowH: 24, onlineAllowed: false, offlineAllowed: true,
};

describe('createOfflineMode', () => {
  it('grantOfflineAdmin makes the offline player the room admin and syncs the room', () => {
    const { runtime, onRole, onRoomState } = makeRuntime(0);
    runtime.grantOfflineAdmin();
    expect(onRole).toHaveBeenCalledWith({ admin: true, moderator: false });
    expect(onRoomState).toHaveBeenCalledOnce();
  });

  it('enterOfflineMode seeds creatures when none exist, then grants admin', () => {
    const { runtime, onRole, populateCreatures } = makeRuntime(0);
    runtime.enterOfflineMode();
    expect(populateCreatures).toHaveBeenCalledOnce();
    expect(onRole).toHaveBeenCalledWith({ admin: true, moderator: false });
  });

  it('enterOfflineMode does not reseed when creatures already exist', () => {
    const { runtime, populateCreatures } = makeRuntime(5);
    runtime.enterOfflineMode();
    expect(populateCreatures).not.toHaveBeenCalled();
  });

  it('enterOfflineMode seeds the local room from the lobby admin config when present', () => {
    const { runtime, applyRoomState, onRole } = makeRuntime(0, LOBBY_ROOM);
    runtime.enterOfflineMode();
    expect(applyRoomState).toHaveBeenCalledWith(LOBBY_ROOM);
    expect(onRole).toHaveBeenCalledWith({ admin: true, moderator: false });
  });

  it('enterOfflineMode keeps the offline defaults when there is no lobby config', () => {
    const { runtime, applyRoomState } = makeRuntime(0, null);
    runtime.enterOfflineMode();
    expect(applyRoomState).not.toHaveBeenCalled();
  });
});
