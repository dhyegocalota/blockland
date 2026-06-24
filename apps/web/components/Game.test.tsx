// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const useGame = vi.fn();
vi.mock('../hooks/use-game', () => ({ useGame: () => useGame() }));

import Game from './Game';
import { LoaderPhase } from '../lib/engine/loader-state';

afterEach(cleanup);

// A full-enough useGame return so the in-game HUD renders; overrides tweak only the fields under test.
function gameState(overrides: Record<string, unknown> = {}) {
  return {
    failed: false,
    brand: { id: 't1', name: 'Test', image: '/i.png', online_allowed: true, offline_allowed: true },
    offline: false, offlineDismissed: true, setOfflineDismissed: () => {},
    name: 'Kid', look: { skin: '#fff', shirt: '#fff', hair: '#fff' }, solo: false, setSolo: () => {}, soloRef: { current: false }, modeGates: { online: { disabled: false, reason: 0 }, offline: { disabled: false, reason: 0 } },
    loaderState: { phase: LoaderPhase.Idle }, retryStart: () => {},
    netState: 'connecting' as const, ping: 0, online: 1, connectKey: null as string | null,
    roster: [], rosterOpen: false, setRosterOpen: () => {},
    debugOpen: false, setDebugOpen: () => {}, debugData: null,
    loginStep: null, loginEmail: '', setLoginEmail: () => {}, loginCode: '', setLoginCode: () => {}, loginBusy: false, loginError: null,
    authToast: null, loggedIn: false, lobbyAdmin: false, lobbyModerator: false, isTouch: false,
    infiniteResources: true, setInfiniteResources: () => {},
    settings: { mouseSensitivity: 1, touchSensitivity: 1, volume: 1, muted: false }, onSettingChange: () => {},
    lobby: { roster: [], room: { suspended: false, playtimeLimitMin: 0, playtimeWindowH: 0 } },
    gameApiRef: { current: null },
    feed: [], room: { peace: true, blockedStructures: [], pvp: false, chatEnabled: false, suspended: false, approvalRequired: false, playtimeLimitMin: 0, playtimeWindowH: 0, onlineAllowed: true, offlineAllowed: true },
    isAdmin: false, isModerator: false, adminOpen: false, setAdminOpen: () => {}, resetArmed: false, resetWorld: () => {}, resetScoresArmed: false, resetScores: () => {},
    toggleRoomPeace: () => {}, toggleStructure: () => {}, toggleRoomPvp: () => {}, toggleRoomChat: () => {}, kickPlayer: () => {}, banPlayer: () => {}, reportPlayer: () => {}, setRole: () => {}, suspendRoom: () => {},
    pendingApprovals: [], toggleApprovalRequired: () => {}, approvePlayer: () => {}, rejectPlayer: () => {}, banPending: () => {},
    bans: [], unban: () => {}, setLimits: () => {}, toggleOnlineAllowed: () => {}, toggleOfflineAllowed: () => {}, updateRequired: false,
    chatLines: [], chatOpen: false, chatDraft: '', setChatDraft: () => {}, chatInputRef: { current: null }, openChat: () => {}, sendChat: () => {}, closeChat: () => {},
    onNameChange: () => {}, onLookChange: () => {}, requestCode: () => {}, verifyCode: () => {}, logout: () => {}, playAsGuest: () => {}, playOffline: () => {}, discardName: () => {},
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

  it('shows the ping online but hides it in offline solo (no network round-trip to ping)', () => {
    useGame.mockReturnValue(gameState({ netState: 'online', solo: false }));
    render(<Game />);
    expect(document.getElementById('ping')).toBeInTheDocument();
    cleanup();
    useGame.mockReturnValue(gameState({ netState: 'online', solo: true }));
    render(<Game />);
    expect(document.getElementById('ping')).toBeNull();
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

  it('shows the big time-up lobby banner when the join was rejected for spent play time', () => {
    useGame.mockReturnValue(gameState({ netState: 'time_up', connectKey: null }));
    render(<Game />);
    const banner = document.getElementById('lobbyBlock')!;
    expect(banner).toBeInTheDocument();
    expect(banner.className).toBe('time_up');
    expect(banner.textContent).toContain('tempo de hoje');
  });

  it('shows the big paused lobby banner when the world is suspended (room_closed join)', () => {
    useGame.mockReturnValue(gameState({ netState: 'room_closed', connectKey: null }));
    render(<Game />);
    const banner = document.getElementById('lobbyBlock')!;
    expect(banner).toBeInTheDocument();
    expect(banner.className).toBe('paused');
    expect(banner.textContent).toContain('pausou o mundo');
  });

  it('shows the paused lobby banner proactively from the live lobby-admin suspended flag', () => {
    useGame.mockReturnValue(
      gameState({
        netState: null,
        lobbyAdmin: true,
        lobby: { roster: [], room: { suspended: true, playtimeLimitMin: 0, playtimeWindowH: 0 } },
      }),
    );
    render(<Game />);
    expect(document.getElementById('lobbyBlock')?.className).toBe('paused');
  });

  it('has no lobby block banner on a normal lobby', () => {
    useGame.mockReturnValue(gameState({ netState: null, connectKey: null }));
    render(<Game />);
    expect(document.getElementById('lobbyBlock')).toBeNull();
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

  it('hides the kick button for an admin target from a moderator, but shows it for a normal player', () => {
    useGame.mockReturnValue(
      gameState({
        netState: 'online',
        connectKey: null,
        isModerator: true,
        adminOpen: true,
        roster: [
          { id: 1, name: 'BossAdmin', self: false, admin: true, moderator: false, pvpKills: 0, away: false },
          { id: 2, name: 'NormalKid', self: false, admin: false, moderator: false, pvpKills: 0, away: false },
        ],
      }),
    );
    render(<Game />);
    const rows = within(document.getElementById('adminPlayers')!).getAllByRole('listitem');
    expect(rows[0].querySelector('.kick')).toBeNull();
    expect(rows[1].querySelector('.kick')).not.toBeNull();
  });

  it('offers a "Play offline" button on the email login step that boots offline with the name', () => {
    const playOffline = vi.fn();
    useGame.mockReturnValue(gameState({ loginStep: 'email', playOffline }));
    render(<Game />);
    const offline = document.getElementById('loginOffline')!;
    expect(offline).toBeInTheDocument();
    expect(offline.textContent).toBe('🔵 Jogar offline com esse nome');
    fireEvent.click(offline);
    expect(playOffline).toHaveBeenCalledOnce();
  });

  it('offers the "Play offline" button on the code login step too', () => {
    useGame.mockReturnValue(gameState({ loginStep: 'code' }));
    render(<Game />);
    expect(document.getElementById('loginOffline')).toBeInTheDocument();
  });

  it('frames the login modal as an online-name claim (reworded title + body)', () => {
    useGame.mockReturnValue(gameState({ loginStep: 'email', name: 'Maria' }));
    render(<Game />);
    const modal = document.getElementById('loginModal')!;
    expect(within(modal).getByRole('heading').textContent).toBe('Jogar online com "Maria"');
    expect(modal.textContent).toContain('online');
    expect(modal.textContent).toContain('offline');
  });

  it('shows the ⚙ gear button in the HUD action row', () => {
    useGame.mockReturnValue(gameState({ netState: 'online', connectKey: null }));
    render(<Game />);
    const gear = document.getElementById('settingsBtn')!;
    expect(gear).toBeInTheDocument();
    expect(gear.textContent).toContain('⚙️ Ajustes');
    expect(document.getElementById('actionRow')).toContainElement(gear);
  });

  it('renders the settings panel hidden, with both sensitivity sliders, volume + mute, and a resume button', () => {
    useGame.mockReturnValue(gameState({ netState: 'online', connectKey: null }));
    render(<Game />);
    const panel = document.getElementById('settings')!;
    expect(panel).toBeInTheDocument();
    expect(panel.hidden).toBe(true);
    expect(panel.querySelector('h2')!.textContent).toBe('⚙️ Ajustes');
    expect(document.getElementById('settingsVolume')).toBeInTheDocument();
    expect(document.getElementById('settingsMouse')).toBeInTheDocument();
    expect(document.getElementById('settingsTouch')).toBeInTheDocument();
    expect(document.getElementById('settingsMute')).toBeInTheDocument();
    expect(document.getElementById('closeSettings')!.textContent).toBe('▶ Voltar a jogar');
  });

  it('reflects the live settings on the sliders + mute toggle', () => {
    useGame.mockReturnValue(
      gameState({
        netState: 'online', connectKey: null,
        settings: { mouseSensitivity: 2, touchSensitivity: 0.5, volume: 0.4, muted: true },
      }),
    );
    render(<Game />);
    expect((document.getElementById('settingsVolume') as HTMLInputElement).value).toBe('0.4');
    expect((document.getElementById('settingsVolume') as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById('settingsMouse') as HTMLInputElement).value).toBe('2');
    expect((document.getElementById('settingsTouch') as HTMLInputElement).value).toBe('0.5');
    expect(document.getElementById('settingsMute')!.className).toBe('on');
    expect(document.getElementById('settings')!.textContent).toContain('40%');
    expect(document.getElementById('settings')!.textContent).toContain('2.00x');
  });

  it('moving a slider or toggling mute pushes the change to the store', () => {
    const onSettingChange = vi.fn();
    useGame.mockReturnValue(gameState({ netState: 'online', connectKey: null, onSettingChange }));
    render(<Game />);
    fireEvent.change(document.getElementById('settingsVolume')!, { target: { value: '0.2' } });
    expect(onSettingChange).toHaveBeenCalledWith({ volume: 0.2 });
    fireEvent.change(document.getElementById('settingsMouse')!, { target: { value: '1.5' } });
    expect(onSettingChange).toHaveBeenCalledWith({ mouseSensitivity: 1.5 });
    fireEvent.click(document.getElementById('settingsMute')!);
    expect(onSettingChange).toHaveBeenCalledWith({ muted: true });
  });

  // The settings panel is a sibling of the HUD, not an overlay over it: so when paused with the panel
  // CLOSED (settingsEl.hidden, which the engine toggles), the full in-game HUD — action row gear/build/
  // chat + the admin panel toggle — is still rendered and reachable. Closing the panel never hides them.
  it('keeps the full in-game HUD (gear, build, chat, admin toggle) rendered alongside the settings panel', () => {
    useGame.mockReturnValue(
      gameState({
        netState: 'online', connectKey: null, isAdmin: true,
        room: { peace: true, blockedStructures: [], pvp: false, chatEnabled: true, suspended: false, approvalRequired: false, playtimeLimitMin: 0, playtimeWindowH: 0, onlineAllowed: true, offlineAllowed: true },
      }),
    );
    render(<Game />);
    expect(document.getElementById('settingsBtn')).toBeInTheDocument();
    expect(document.getElementById('buildBtn')).toBeInTheDocument();
    expect(document.getElementById('chatBtn')).toBeInTheDocument();
    expect(document.getElementById('adminToggle')).toBeInTheDocument();
    expect(document.getElementById('settings')).toBeInTheDocument();
  });

  it('shows the keyboard-shortcut key-cap on each desktop HUD button', () => {
    useGame.mockReturnValue(
      gameState({
        netState: 'online', connectKey: null, isTouch: false,
        room: { peace: true, blockedStructures: [], pvp: false, chatEnabled: true, suspended: false, approvalRequired: false, playtimeLimitMin: 0, playtimeWindowH: 0, onlineAllowed: true, offlineAllowed: true },
      }),
    );
    render(<Game />);
    expect(document.getElementById('helpBtn')!.querySelector('.hotkeyHint')!.textContent).toBe('V');
    expect(document.getElementById('buildBtn')!.querySelector('.hotkeyHint')!.textContent).toBe('B');
    expect(document.getElementById('flyBtn')!.querySelector('.hotkeyHint')!.textContent).toBe('F');
    expect(document.getElementById('spawnBtn')!.querySelector('.hotkeyHint')!.textContent).toBe('H');
    expect(document.getElementById('chatBtn')!.querySelector('.hotkeyHint')!.textContent).toBe('T');
    expect(document.getElementById('settingsBtn')!.querySelector('.hotkeyHint')!.textContent).toBe('Esc');
    expect(document.getElementById('presenceToggle')!.querySelector('.hotkeyHint')!.textContent).toBe('Tab');
    // Exit reloads the page, so it deliberately has no shortcut.
    expect(document.getElementById('exitBtn')!.querySelector('.hotkeyHint')).toBeNull();
  });

  it('hides every key-cap on touch devices (no keyboard)', () => {
    useGame.mockReturnValue(
      gameState({
        netState: 'online', connectKey: null, isTouch: true, isAdmin: true,
        room: { peace: true, blockedStructures: [], pvp: false, chatEnabled: true, suspended: false, approvalRequired: false, playtimeLimitMin: 0, playtimeWindowH: 0, onlineAllowed: true, offlineAllowed: true },
      }),
    );
    render(<Game />);
    expect(document.querySelectorAll('.hotkeyHint')).toHaveLength(0);
  });

  it('shows the admin-panel key-cap (M) only for an admin/moderator', () => {
    useGame.mockReturnValue(gameState({ netState: 'online', connectKey: null, isAdmin: true }));
    render(<Game />);
    expect(document.getElementById('adminToggle')!.querySelector('.hotkeyHint')!.textContent).toBe('M');
    cleanup();
    useGame.mockReturnValue(gameState({ netState: 'online', connectKey: null }));
    render(<Game />);
    expect(document.getElementById('adminToggle')).toBeNull();
  });
});
