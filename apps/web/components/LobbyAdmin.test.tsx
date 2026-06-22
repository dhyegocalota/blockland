// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { useLobbyAdmin } from '../lib/hooks/use-lobby-admin';

vi.mock('../lib/game-engine', () => ({
  STRUCTURE_DEFS: { hut: { labelKey: 'build.hut', builtToastKey: 'toast.built_hut', emoji: '🏠', reach: 1, stamp: () => undefined } },
  STRUCTURE_KINDS: ['hut'],
}));

import LobbyAdmin from './LobbyAdmin';

afterEach(cleanup);

function makeLobby(overrides: Partial<ReturnType<typeof useLobbyAdmin>>): ReturnType<typeof useLobbyAdmin> {
  const noop = vi.fn();
  return {
    state: 'online',
    roster: [],
    room: { peace: true, blockedStructures: [], pvp: false, chatEnabled: true, suspended: false, approvalRequired: false },
    isAdmin: false,
    isModerator: false,
    resetArmed: false,
    resetWorld: noop,
    resetScoresArmed: false,
    resetScores: noop,
    suspendRoom: noop,
    toggleRoomPeace: noop,
    toggleRoomPvp: noop,
    toggleRoomChat: noop,
    toggleStructure: noop,
    kickPlayer: noop,
    banPlayer: noop,
    setRole: noop,
    pendingApprovals: [],
    toggleApprovalRequired: noop,
    approvePlayer: noop,
    rejectPlayer: noop,
    bans: [],
    unban: noop,
    ...overrides,
  } as ReturnType<typeof useLobbyAdmin>;
}

describe('LobbyAdmin', () => {
  it('renders nothing for a non-admin, non-moderator', () => {
    const { container } = render(<LobbyAdmin lobby={makeLobby({ isAdmin: false, isModerator: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the admin panel for an admin', () => {
    const { container } = render(<LobbyAdmin lobby={makeLobby({ isAdmin: true })} />);
    expect(container.querySelector('#lobbyAdmin')).toBeInTheDocument();
    expect(container.querySelector('#adminReset')).toBeInTheDocument();
  });
});
