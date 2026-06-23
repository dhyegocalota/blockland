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

  it('shows the reconnecting overlay (and suppresses the small banner) while a live game drops', () => {
    useGame.mockReturnValue(gameState({ netState: 'reconnecting', connectKey: 'coop.connect_reconnecting' }));
    render(<Game />);
    expect(document.getElementById('connectingOverlay')).toBeInTheDocument();
    expect(screen.getByText('📡 Reconectando…')).toBeInTheDocument();
    // The overlay owns the status; the small netBanner must not double up with its own reconnecting copy.
    expect(document.getElementById('netBanner')).toBeNull();
  });

  it('clears the reconnecting overlay the instant Welcome returns (online)', () => {
    useGame.mockReturnValue(gameState({ netState: 'online', connectKey: null }));
    render(<Game />);
    expect(document.getElementById('connectingOverlay')).toBeNull();
    expect(document.getElementById('netBanner')).toBeNull();
  });

  it('marks an away peer in the presence roster instead of dropping them', () => {
    useGame.mockReturnValue(
      gameState({
        netState: 'online',
        connectKey: null,
        rosterOpen: true,
        roster: [
          { id: 1, name: 'Ana', self: false, admin: false, moderator: false, pvpKills: 0, away: false },
          { id: 2, name: 'Bia', self: false, admin: false, moderator: false, pvpKills: 0, away: true },
        ],
      }),
    );
    render(<Game />);
    const items = within(document.getElementById('presenceList')!).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['Ana', 'Bia 💤 ausente']);
    expect(items[1].className).toBe('away');
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

  it('shows my own pvp kills in the HUD when pvp is on, and hides the stat when off', () => {
    const pvpRoom = { peace: true, blockedStructures: [], pvp: true, chatEnabled: false, suspended: false, approvalRequired: false, playtimeLimitMin: 0, playtimeWindowH: 0, onlineAllowed: true, offlineAllowed: true };
    useGame.mockReturnValue(gameState({
      netState: 'online', connectKey: null, room: pvpRoom,
      roster: [{ id: 1, name: 'Kid', self: true, admin: false, moderator: false, pvpKills: 4, away: false }],
    }));
    render(<Game />);
    expect(document.getElementById('kills')?.textContent).toContain('4');

    cleanup();
    useGame.mockReturnValue(gameState({ netState: 'online', connectKey: null }));
    render(<Game />);
    expect(document.getElementById('kills')).toBeNull();
  });

  it('shows the live feed approval notification with approve/reject/ban for an in-game admin', () => {
    const approvePlayer = vi.fn();
    useGame.mockReturnValue(
      gameState({
        netState: 'online',
        connectKey: null,
        isAdmin: true,
        feed: [{ id: 1, at: 0, kind: 'approval', name: 'Guest', detail: 'ip:1.2.3.4' }],
        pendingApprovals: [{ accountId: 'ip:1.2.3.4', name: 'Guest', email: '' }],
        approvePlayer,
      }),
    );
    render(<Game />);
    const feed = document.getElementById('feed')!;
    expect(within(feed).getByText('Guest quer entrar')).toBeInTheDocument();
    fireEvent.click(within(feed).getByText('Aprovar'));
    expect(approvePlayer).toHaveBeenCalledWith('ip:1.2.3.4');
  });

  it('hides the feed approval actions once the player is no longer pending', () => {
    useGame.mockReturnValue(
      gameState({
        netState: 'online',
        connectKey: null,
        isAdmin: true,
        feed: [{ id: 1, at: 0, kind: 'approval', name: 'Guest', detail: 'ip:1.2.3.4' }],
        pendingApprovals: [],
      }),
    );
    render(<Game />);
    const feed = document.getElementById('feed')!;
    expect(within(feed).getByText('Guest quer entrar')).toBeInTheDocument();
    expect(within(feed).queryByText('Aprovar')).toBeNull();
  });

  it('ranks the presence roster by pvp kills with the ⚔️ stat when pvp is on', () => {
    useGame.mockReturnValue(
      gameState({
        netState: 'online',
        connectKey: null,
        rosterOpen: true,
        room: { ...gameState().room, pvp: true },
        roster: [
          { id: 1, name: 'Ana', self: false, admin: false, moderator: false, pvpKills: 1 },
          { id: 2, name: 'Bia', self: false, admin: false, moderator: false, pvpKills: 4 },
        ],
      }),
    );
    render(<Game />);
    const items = within(document.getElementById('presenceList')!).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['Bia ⚔️ 4', 'Ana ⚔️ 1']);
  });

  it('shows the presence roster without the ⚔️ stat when pvp is off', () => {
    useGame.mockReturnValue(
      gameState({
        netState: 'online',
        connectKey: null,
        rosterOpen: true,
        room: { ...gameState().room, pvp: false },
        roster: [
          { id: 1, name: 'Ana', self: false, admin: false, moderator: false, pvpKills: 1 },
          { id: 2, name: 'Bia', self: false, admin: false, moderator: false, pvpKills: 4 },
        ],
      }),
    );
    render(<Game />);
    const items = within(document.getElementById('presenceList')!).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['Ana', 'Bia']);
    expect(document.getElementById('presenceList')!.textContent).not.toContain('⚔️');
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
