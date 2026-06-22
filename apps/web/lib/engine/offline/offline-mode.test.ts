import { describe, expect, it, vi } from 'vitest';
import { createOfflineMode } from './offline-mode';
import type { GameRuntime } from '../runtime';

function makeRuntime(creatureCount: number) {
  const onRole = vi.fn();
  const onRoomState = vi.fn();
  const populateCreatures = vi.fn();
  const runtime = {
    bridge: { hud: { onRole, onRoomState } },
    creatures: new Array(creatureCount).fill(0),
    populateCreatures,
    currentRoom: () => ({ suspended: false }),
  } as unknown as GameRuntime;
  createOfflineMode(runtime);
  return { runtime, onRole, onRoomState, populateCreatures };
}

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
});
