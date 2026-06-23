// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const useGame = vi.fn();
vi.mock('../hooks/use-game', () => ({ useGame: () => useGame() }));

import Game from './Game';

afterEach(cleanup);

// A full-enough useGame return so the in-game HUD renders; overrides tweak only the fields under test.
function gameState(overrides: Record<string, unknown> = {}) {
  return {
    failed: false,
    brand: { id: 't1', name: 'Test', image: '/i.png', online_allowed: true, offline_allowed: true },
    offline: false, offlineDismissed: true, setOfflineDismissed: () => {},
    name: 'Kid', look: { skin: '#fff', shirt: '#fff', hair: '#fff' }, solo: false, setSolo: () => {}, soloRef: { current: false }, modeGates: { online: { disabled: false, reason: 0 }, offline: { disabled: false, reason: 0 } },
    netState: 'connecting' as const, ping: 0, online: 1, connectKey: null as string | null,
    roster: [], rosterOpen: false, setRosterOpen: () => {},
    debugOpen: false, setDebugOpen: () => {}, debugData: null,
    loginStep: null, loginEmail: '', setLoginEmail: () => {}, loginCode: '', setLoginCode: () => {}, loginBusy: false, loginError: null,
    authToast: null, loggedIn: false, lobbyAdmin: false, lobbyModerator: false, isTouch: false,
    infiniteResources: true, setInfiniteResources: () => {},
    lobby: { roster: [] },
    gameApiRef: { current: null },
    feed: [], room: { peace: true, blockedStructures: [], pvp: false, chatEnabled: false, suspended: false, approvalRequired: false, playtimeLimitMin: 0, playtimeWindowH: 0, onlineAllowed: true, offlineAllowed: true },
    isAdmin: false, isModerator: false, adminOpen: false, setAdminOpen: () => {}, resetArmed: false, resetWorld: () => {}, resetScoresArmed: false, resetScores: () => {},
    toggleRoomPeace: () => {}, toggleStructure: () => {}, toggleRoomPvp: () => {}, toggleRoomChat: () => {}, kickPlayer: () => {}, banPlayer: () => {}, reportPlayer: () => {}, setRole: () => {}, suspendRoom: () => {},
    pendingApprovals: [], toggleApprovalRequired: () => {}, approvePlayer: () => {}, rejectPlayer: () => {}, banPending: () => {},
    bans: [], unban: () => {}, setLimits: () => {}, toggleOnlineAllowed: () => {}, toggleOfflineAllowed: () => {}, updateRequired: false,
    chatLines: [], chatOpen: false, chatDraft: '', setChatDraft: () => {}, chatInputRef: { current: null }, openChat: () => {}, sendChat: () => {}, closeChat: () => {},
    onNameChange: () => {}, onLookChange: () => {}, requestCode: () => {}, verifyCode: () => {}, logout: () => {}, playAsGuest: () => {}, discardName: () => {},
    ...overrides,
  };
}

describe('Game', () => {
  it('shows the load error when the tenant failed to resolve', () => {
    useGame.mockReturnValue({ failed: true });
    render(<Game />);
    expect(screen.getByText((_, node) => node?.id === 'loadError')).toBeInTheDocument();
  });

  it('renders nothing until the brand resolves', () => {
    useGame.mockReturnValue({ failed: false, brand: null });
    const { container } = render(<Game />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the connecting overlay with the live status while joining online', () => {
    useGame.mockReturnValue(gameState({ netState: 'connecting', connectKey: 'coop.connect_connecting' }));
    render(<Game />);
    expect(document.getElementById('connectingOverlay')).toBeInTheDocument();
    expect(screen.getByText('🔌 Conectando…')).toBeInTheDocument();
  });

  it('hides the connecting overlay once the world is interactive', () => {
    useGame.mockReturnValue(gameState({ netState: 'online', connectKey: null }));
    render(<Game />);
    expect(document.getElementById('connectingOverlay')).toBeNull();
  });

  it('shows the waiting-for-approval overlay (not the connecting one) when held for approval', () => {
    useGame.mockReturnValue(gameState({ netState: 'needs_approval', connectKey: 'coop.connect_connecting' }));
    render(<Game />);
    expect(document.getElementById('connectingOverlay')).toBeNull();
    expect(document.getElementById('approvalOverlay')).toBeInTheDocument();
  });

  it('shows the Online mode badge when playing online', () => {
    useGame.mockReturnValue(gameState({ netState: 'online', connectKey: null, solo: false }));
    render(<Game />);
    const badge = document.getElementById('modeBadge');
    expect(badge?.textContent).toContain('Online');
    expect(badge?.className).toBe('online');
  });

  it('shows the Offline mode badge when playing solo', () => {
    useGame.mockReturnValue(gameState({ solo: true }));
    render(<Game />);
    const badge = document.getElementById('modeBadge');
    expect(badge?.textContent).toContain('Offline');
    expect(badge?.className).toBe('offline');
  });

  it('bans a pending player from the admin approval list', () => {
    const banPending = vi.fn();
    useGame.mockReturnValue(
      gameState({
        netState: 'online',
        connectKey: null,
        isAdmin: true,
        adminOpen: true,
        pendingApprovals: [{ accountId: 'ip:1.2.3.4', name: 'Guest', email: '' }],
        banPending,
      }),
    );
    render(<Game />);
    const pending = document.getElementById('adminPending')!;
    fireEvent.click(within(pending).getByText('Banir'));
    expect(banPending).toHaveBeenCalledWith('ip:1.2.3.4');
  });
});
