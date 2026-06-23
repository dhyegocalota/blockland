// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { useLobbyAdmin } from '../hooks/use-lobby-admin';

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
    room: { peace: true, blockedStructures: [], pvp: false, chatEnabled: true, suspended: false, approvalRequired: false, playtimeLimitMin: 0, playtimeWindowH: 0, onlineAllowed: true, offlineAllowed: true },
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
    reportPlayer: noop,
    reports: [],
    setRole: noop,
    pendingApprovals: [],
    toggleApprovalRequired: noop,
    approvePlayer: noop,
    rejectPlayer: noop,
    banPending: noop,
    bans: [],
    unban: noop,
    setLimits: noop,
    toggleOnlineAllowed: noop,
    toggleOfflineAllowed: noop,
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

  it('no longer offers a per-player report button (feature removed)', () => {
    const { container } = render(
      <LobbyAdmin lobby={makeLobby({ isAdmin: true, roster: [{ id: 2, name: 'Kid', self: false, admin: false, moderator: false, pvpKills: 0, away: false }] })} />,
    );
    const players = container.querySelector('#adminPlayers') as HTMLElement;
    expect(within(players).queryByText('Reportar')).toBeNull();
    expect(container.querySelector('#adminReports')).toBeNull();
  });

  it('keeps the lobby chat + hours-played reports, labelled last 30 days', () => {
    const { container } = render(<LobbyAdmin lobby={makeLobby({ isAdmin: true })} />);
    expect(container.querySelector('#adminPlaytimeReport')).toBeInTheDocument();
    expect(container.querySelector('#adminChatReport')).toBeInTheDocument();
  });

  it('bans a pending player from the approval list', () => {
    const banPending = vi.fn();
    const { container } = render(
      <LobbyAdmin
        lobby={makeLobby({
          isAdmin: true,
          pendingApprovals: [{ accountId: 'ip:1.2.3.4', name: 'Guest', email: '' }],
          banPending,
        })}
      />,
    );
    const pending = container.querySelector('#adminPending') as HTMLElement;
    fireEvent.click(within(pending).getByText('Banir'));
    expect(banPending).toHaveBeenCalledWith('ip:1.2.3.4');
  });
});
