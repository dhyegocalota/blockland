'use client';

import { t } from '../lib/i18n';
import { STRUCTURE_DEFS, STRUCTURE_KINDS } from '../lib/game-engine';
import { type FeedEntry, type FeedEventKind } from '../lib/feed';
import { ModeBlockReason } from '../lib/lobby-modes';
import type { NetState } from '../lib/net';
import Leaderboard from './Leaderboard';
import LobbyPresence from './LobbyPresence';
import LobbyAdmin from './LobbyAdmin';
import AdminLimits from './AdminLimits';
import LocaleSwitcher from './LocaleSwitcher';
import { useGame } from '../hooks/use-game';
import { roleBadge } from '../lib/roster-roles';
import { rootHomeUrl } from '../lib/seo';

const AUTHOR_URL = 'https://dhyegocalota.com.br';

const BANNER_KEYS: Record<NetState, string | null> = {
  connecting: 'coop.connecting',
  online: null,
  reconnecting: 'coop.reconnecting',
  offline: 'coop.offline',
  banned: 'coop.banned',
  kicked: 'coop.kicked',
  room_closed: 'coop.room_closed',
  time_up: 'coop.time_up',
  online_blocked: 'coop.online_blocked',
  needs_approval: null,
  needs_login: 'coop.needs_login',
  rejected: 'coop.rejected',
};

const SEVERE_STATES: NetState[] = ['banned', 'kicked', 'room_closed', 'time_up', 'online_blocked', 'needs_login', 'rejected'];

// Why a lobby mode button is disabled → the short hint shown under the mode toggle.
const MODE_BLOCK_HINT_KEYS: Record<ModeBlockReason, string | null> = {
  [ModeBlockReason.Allowed]: null,
  [ModeBlockReason.Unreachable]: 'lobby.mode_offline_hint',
  [ModeBlockReason.AdminDisabled]: 'lobby.mode_blocked_hint',
};

const FEED_ICONS: Record<FeedEventKind, string> = {
  join: '➕',
  leave: '➖',
  chat: '💬',
  rename: '✏️',
  kill: '⚔️',
  reset: '🌍',
  reset_scores: '🏆',
  server_down: '⚠️',
  admin: '🛡️',
  approval: '🙋',
};

function feedText(entry: FeedEntry): string {
  if (entry.kind === 'kill' && entry.detail) return t('feed.kill', { name: entry.name, detail: entry.detail });
  if (entry.kind === 'rename' && entry.detail) return t('feed.renamed', { old: entry.detail, name: entry.name });
  if (entry.kind === 'rename') return entry.name;
  if (entry.kind === 'reset') return t('feed.reset', { name: entry.name });
  if (entry.kind === 'reset_scores') return t('feed.reset_scores', { name: entry.name });
  if (entry.kind === 'server_down') return t('feed.server_down');
  if (entry.kind === 'approval') return t('feed.approval', { name: entry.name });
  if (entry.kind === 'admin') {
    const parts = entry.detail ? entry.detail.split('|') : [];
    const action = parts[0];
    const target = parts[1];
    if (target) return t(`feed.admin_${action}`, { name: entry.name, target });
    return t(`feed.admin_${action}`, { name: entry.name });
  }
  return t(entry.kind === 'join' ? 'feed.joined' : 'feed.left', { name: entry.name });
}

export default function Game() {
  const {
    brand, failed, offline, offlineDismissed, setOfflineDismissed,
    name, look, solo, setSolo, soloRef, modeGates,
    netState, ping, online, connectKey,
    roster, rosterOpen, setRosterOpen,
    debugOpen, setDebugOpen, debugData, debugCopied, copyDebugReport,
    loginStep, loginEmail, setLoginEmail, loginCode, setLoginCode, loginBusy, loginError,
    authToast, loggedIn, lobbyAdmin, lobbyModerator, isTouch,
    infiniteResources, setInfiniteResources,
    lobby,
    gameApiRef,
    feed, room, isAdmin, isModerator, adminOpen, setAdminOpen, resetArmed, resetWorld, resetScoresArmed, resetScores,
    toggleRoomPeace, toggleStructure, toggleRoomPvp, toggleRoomChat, kickPlayer, banPlayer, reportPlayer, setRole, suspendRoom,
    pendingApprovals, toggleApprovalRequired, approvePlayer, rejectPlayer,
    bans, unban, setLimits, toggleOnlineAllowed, toggleOfflineAllowed, updateRequired,
    chatLines, chatOpen, chatDraft, setChatDraft, chatInputRef, openChat, sendChat, closeChat,
    onNameChange, onLookChange, requestCode, verifyCode, logout, playAsGuest, discardName,
  } = useGame();

  if (failed) return <div id="loadError">{t('error.connect')}</div>;
  if (!brand) return null;

  const bannerKey = netState ? BANNER_KEYS[netState] : null;
  const severe = netState ? SEVERE_STATES.includes(netState) : false;
  const showPing = netState === 'online';

  if (updateRequired) {
    return (
      <div id="updateOverlay" role="alertdialog" aria-modal="true">
        <div className="panel">
          <div className="updateSpinner" aria-hidden="true">✨</div>
          <h2>{t('update.title')}</h2>
          <p>{t('update.body')}</p>
          <button onClick={() => window.location.reload()}>{t('update.button')}</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div id="hurtFlash"></div>
      <div id="hud">
        <div id="topbar">
          <img src={brand.image} alt={brand.name} />
          <span className="title">{brand.name}</span>
          <span className="stat" id="hearts">❤️❤️❤️</span>
          <span className="stat" id="stars">⭐ 0</span>
          <span className="stat record" id="record">🏆 0</span>
          <span className="stat" id="bag">🎒 0</span>
          {showPing && <span className="stat" id="ping">{t('coop.ping', { ping })}</span>}
        </div>
        <div id="crosshair"></div>
        <div id="toast"></div>
        <div id="hotbar"></div>
        <div id="actionRow">
          <button className="btn" id="helpBtn">{t('hud.controls')}</button>
          <button className="btn" id="buildBtn">{t('hud.build')}</button>
          <button className="btn" id="flyBtn">{t('hud.fly')}</button>
          <button className="btn" id="spawnBtn" onClick={() => gameApiRef.current?.returnToSpawn()}>{t('hud.spawn')}</button>
          {room.chatEnabled && <button className="btn" id="chatBtn" onClick={openChat}>{t('hud.chat')}</button>}
          <button className="btn" id="exitBtn" onClick={() => window.location.reload()}>{t('hud.exit')}</button>
        </div>
      </div>

      <div id="presence" className={rosterOpen ? 'open' : undefined}>
        <button id="presenceToggle" onClick={() => setRosterOpen((open) => !open)} aria-expanded={rosterOpen}>
          👥 {online}
        </button>
        {rosterOpen && (
          <ul id="presenceList">
            {roster.map((player) => (
              <li key={player.id} className={player.self ? 'self' : undefined}>
                {player.self ? t('presence.you', { name: player.name }) : player.name}
              </li>
            ))}
          </ul>
        )}
      </div>

      {(isAdmin || isModerator) && (
        <div id="adminPanel" className={adminOpen ? 'open' : undefined}>
          <button id="adminToggle" onClick={() => setAdminOpen((open) => !open)} aria-expanded={adminOpen}>
            {isAdmin ? '🛡️' : '🧒'} {t(isAdmin ? 'game_admin.title' : 'game_admin.title_mod')}
          </button>
          {adminOpen && (
            <div id="adminBody">
              <button
                id="adminPeace"
                className={room.peace ? undefined : 'on'}
                onClick={toggleRoomPeace}
              >
                {room.peace ? t('game_admin.monsters_calm') : t('game_admin.monsters_attack')}
              </button>
              {!solo && (
                <button
                  id="adminPvp"
                  className={room.pvp ? 'on' : undefined}
                  onClick={toggleRoomPvp}
                >
                  {room.pvp ? t('game_admin.pvp_on') : t('game_admin.pvp_off')}
                </button>
              )}
              {isAdmin && !solo && (
                <button
                  id="adminChat"
                  className={room.chatEnabled ? undefined : 'on'}
                  onClick={toggleRoomChat}
                >
                  {room.chatEnabled ? t('game_admin.chat_on') : t('game_admin.chat_off')}
                </button>
              )}
              {isAdmin && !solo && (
                <button
                  id="adminApproval"
                  className={room.approvalRequired ? 'on' : undefined}
                  onClick={toggleApprovalRequired}
                >
                  {room.approvalRequired ? t('game_admin.approval_on') : t('game_admin.approval_off')}
                </button>
              )}
              {isAdmin && !solo && (
                <AdminLimits
                  room={room}
                  setLimits={setLimits}
                  toggleOnlineAllowed={toggleOnlineAllowed}
                  toggleOfflineAllowed={toggleOfflineAllowed}
                />
              )}
              {isAdmin && pendingApprovals.length > 0 && (
                <>
                  <span className="adminLabel">{t('game_admin.pending')}</span>
                  <ul id="adminPending">
                    {pendingApprovals.map((entry) => (
                      <li key={entry.accountId}>
                        <span className="playerName">{entry.name}</span>
                        <span className="adminPlayerActions">
                          <button className="role" onClick={() => approvePlayer(entry.accountId)}>{t('game_admin.approve')}</button>
                          <button className="ban" onClick={() => rejectPlayer(entry.accountId)}>{t('game_admin.reject')}</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {isAdmin && bans.length > 0 && (
                <>
                  <span className="adminLabel">{t('game_admin.banned')}</span>
                  <ul id="adminBanned">
                    {bans.map((entry) => (
                      <li key={entry.ip}>
                        <span className="playerName">{entry.name || entry.ip}</span>
                        <span className="adminPlayerActions">
                          <button className="role" onClick={() => unban(entry.ip)}>{t('game_admin.unban')}</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {isAdmin && (
                <button
                  id="adminInfinite"
                  className={infiniteResources ? 'on' : undefined}
                  onClick={() => { const next = !infiniteResources; setInfiniteResources(next); gameApiRef.current?.setInfiniteResources(next); }}
                >
                  {infiniteResources ? t('game_admin.infinite_on') : t('game_admin.infinite_off')}
                </button>
              )}
              <span className="adminLabel">{t('game_admin.players')}</span>
              <ul id="adminPlayers">
                {roster.filter((player) => !player.self).map((player) => {
                  const badge = roleBadge(player);
                  return (
                    <li key={player.id}>
                      <span className="playerName">
                        {badge && <span className="roleBadge">{badge}</span>}
                        {player.name}
                      </span>
                      <span className="adminPlayerActions">
                        {isAdmin && <button className="role" onClick={() => setRole(player.id, 'moderator')}>{t('game_admin.make_mod')}</button>}
                        {isAdmin && <button className="role" onClick={() => setRole(player.id, 'admin')}>{t('game_admin.make_admin')}</button>}
                        {isAdmin && <button className="role" onClick={() => setRole(player.id, 'player')}>{t('game_admin.make_player')}</button>}
                        {(isAdmin || isModerator) && <button className="kick" onClick={() => kickPlayer(player.id)}>{t('game_admin.kick')}</button>}
                        {(isAdmin || isModerator) && <button className="report" onClick={() => reportPlayer(player.id)}>{t('game_admin.report')}</button>}
                        {isAdmin && <button className="ban" onClick={() => banPlayer(player.id)}>{t('game_admin.ban')}</button>}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <span className="adminLabel">{t('game_admin.structures')}</span>
              <ul id="adminStructures">
                {STRUCTURE_KINDS.map((kind) => {
                  const blocked = room.blockedStructures.includes(kind);
                  return (
                    <li key={kind}>
                      <span>{t(STRUCTURE_DEFS[kind].labelKey)}</span>
                      <button
                        className={blocked ? 'blocked' : 'allowed'}
                        onClick={() => toggleStructure(kind, blocked)}
                      >
                        {blocked ? t('game_admin.blocked') : t('game_admin.allowed')}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <button id="adminReset" className={resetArmed ? 'armed' : undefined} onClick={resetWorld}>
                {resetArmed ? t('game_admin.reset_confirm') : t('game_admin.reset')}
              </button>
              {isAdmin && !solo && (
                <button id="adminResetScores" className={resetScoresArmed ? 'armed' : undefined} onClick={resetScores}>
                  {resetScoresArmed ? t('game_admin.reset_scores_confirm') : t('game_admin.reset_scores')}
                </button>
              )}
              {isAdmin && !solo && (
                <button id="adminSuspend" className={room.suspended ? 'on' : undefined} onClick={suspendRoom}>
                  {room.suspended ? t('game_admin.resume') : t('game_admin.suspend')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {bannerKey && !severe && (
        <div id="netBanner" role="status">{t(bannerKey)}</div>
      )}

      {bannerKey && severe && (
        <div id="kickOverlay" role="alertdialog" aria-modal="true">
          <div className="panel">
            <h2>{t(bannerKey)}</h2>
            <button onClick={() => window.location.reload()}>{t('coop.back_to_lobby')}</button>
          </div>
        </div>
      )}

      {connectKey && netState !== 'needs_approval' && (
        <div id="connectingOverlay" role="status" aria-live="polite">
          <div className="panel">
            <div className="connectingSpinner" aria-hidden="true">🧩</div>
            <h2>{t('coop.connect_title')}</h2>
            <p className="connectingState">{t(connectKey)}</p>
            <p>{t('coop.connect_hint')}</p>
          </div>
        </div>
      )}

      {netState === 'needs_approval' && (
        <div id="approvalOverlay" role="alertdialog" aria-modal="true">
          <div className="panel">
            <div className="approvalSpinner" aria-hidden="true">⏳</div>
            <h2>{t('coop.waiting_approval_title')}</h2>
            <p>{t('coop.waiting_approval_hint')}</p>
            <button onClick={() => window.location.reload()}>{t('coop.back_to_lobby')}</button>
          </div>
        </div>
      )}

      {authToast && (
        <div id="authToast" className="severe" role="status">{authToast}</div>
      )}

      {loginStep && (
        <div
          id="loginModal"
          role="dialog"
          aria-modal="true"
          onClick={(event) => { if (event.target === event.currentTarget) discardName(); }}
        >
          <div className="panel">
            {loginStep === 'email' && (
              <>
                <h2>{t('login.email_title')}</h2>
                <p>{t('login.email_hint', { name: name.trim() })}</p>
                <input
                  id="loginEmail"
                  type="email"
                  value={loginEmail}
                  placeholder={t('login.email_placeholder')}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.code === 'Enter') { e.preventDefault(); requestCode(); } }}
                />
                {loginError && <p className="loginError">{loginError}</p>}
                <button id="loginSend" disabled={loginBusy || !loginEmail.trim()} onClick={requestCode}>
                  {loginBusy ? t('login.sending') : t('login.send_code')}
                </button>
                <button id="loginCancel" className="ghost" onClick={playAsGuest}>{t('login.random_name')}</button>
              </>
            )}
            {loginStep === 'code' && (
              <>
                <h2>{t('login.code_title')}</h2>
                <p>{t('login.code_hint', { email: loginEmail.trim() })}</p>
                <p className="loginSpam">{t('login.code_spam')}</p>
                <input
                  id="loginCode"
                  autoFocus
                  inputMode="numeric"
                  maxLength={6}
                  value={loginCode}
                  placeholder={t('login.code_placeholder')}
                  onChange={(e) => setLoginCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => { if (e.code === 'Enter') { e.preventDefault(); verifyCode(); } }}
                />
                {loginError && <p className="loginError">{loginError}</p>}
                <button id="loginVerify" disabled={loginBusy || loginCode.trim().length < 6} onClick={verifyCode}>
                  {loginBusy ? t('login.verifying') : t('login.verify')}
                </button>
                <button id="loginCancel" className="ghost" onClick={playAsGuest}>{t('login.random_name')}</button>
              </>
            )}
          </div>
        </div>
      )}

      {offline && !offlineDismissed && (
        <div id="offlineNotice" role="dialog" aria-modal="true">
          <div className="panel">
            <h2>{t('offline.title')}</h2>
            <p>{t('offline.body')}</p>
            <button id="offlinePlay" onClick={() => setOfflineDismissed(true)}>{t('offline.play')}</button>
          </div>
        </div>
      )}

      <div id="feed">
        {feed.map((entry) => (
          <div className={entry.kind === 'rename' || entry.kind === 'kill' ? 'feedLine system' : 'feedLine'} key={entry.id}>
            <span className="feedIcon">{FEED_ICONS[entry.kind]}</span>
            {feedText(entry)}
            {isAdmin && entry.kind === 'approval' && entry.detail && pendingApprovals.some((pending) => pending.accountId === entry.detail) && (
              <span className="adminPlayerActions">
                <button className="role" onClick={() => approvePlayer(entry.detail!)}>{t('game_admin.approve')}</button>
                <button className="ban" onClick={() => rejectPlayer(entry.detail!)}>{t('game_admin.reject')}</button>
              </span>
            )}
          </div>
        ))}
      </div>

      <div id="chat" hidden={!room.chatEnabled}>
        <div id="chatLog">
          {chatLines.map((line) => (
            <div className="chatLine" key={line.id}>{t('chat.line', { name: line.name, text: line.text })}</div>
          ))}
        </div>
        {chatOpen && (
          <input
            id="chatInput"
            ref={chatInputRef}
            value={chatDraft}
            placeholder={t('chat.placeholder')}
            onChange={(e) => setChatDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.code === 'Enter') { e.preventDefault(); sendChat(); }
              if (e.code === 'Escape') { e.preventDefault(); closeChat(); }
            }}
          />
        )}
      </div>

      <button
        id="debugToggle"
        className={debugOpen ? 'on' : undefined}
        onClick={() => setDebugOpen((open) => !open)}
        title={t('debug.title')}
        aria-label={t('debug.aria')}
      >
        🐞
      </button>

      {debugOpen && debugData && (
        <div id="debugPanel">
          <h3>{t('debug.title')}</h3>
          <div><span>{t('debug.fps')}</span><b>{debugData.fps}</b></div>
          <div><span>{t('debug.ping')}</span><b>{debugData.ping}ms</b></div>
          <div><span>{t('debug.state')}</span><b>{debugData.state}</b></div>
          <div><span>{t('debug.online')}</span><b>{debugData.online}</b></div>
          <div><span>{t('debug.pos')}</span><b>{debugData.x.toFixed(2)}, {debugData.y.toFixed(2)}, {debugData.z.toFixed(2)}</b></div>
          <div><span>{t('debug.chunks')}</span><b>{debugData.chunks}</b></div>
          <div><span>{t('debug.tenant')}</span><b>{debugData.tenant}</b></div>
          <div><span>{t('debug.front_version')}</span><b>{debugData.frontVersion}</b></div>
          <div><span>{t('debug.back_version')}</span><b>{debugData.backendVersion}</b></div>
          <button id="debugCopy" onClick={copyDebugReport}>
            {debugCopied ? t('debug.copied') : t('debug.copy_report')}
          </button>
        </div>
      )}

      <div id="touchControls" style={{ display: 'none' }}>
        <div id="joystick"><div id="joyKnob"></div></div>
        <div id="touchButtons">
          <button id="btnUp" className="tbtn">⤴️</button>
          <button id="btnDown" className="tbtn">⤵️</button>
          <button id="btnPlace" className="tbtn place">🧱</button>
          <button id="btnBreak" className="tbtn break">⛏️</button>
        </div>
      </div>

      <div id="controls" hidden>
        <div className="panel">
          <h2>{t('controls.title')}</h2>
          {isTouch ? (
            <div className="ctrlGrid">
              <div className="card"><b>{t('controls.t_move')}</b> {t('controls.t_move_d')}</div>
              <div className="card"><b>{t('controls.t_jump')}</b> {t('controls.t_jump_d')}</div>
              <div className="card"><b>{t('controls.t_down')}</b> {t('controls.t_down_d')}</div>
              <div className="card"><b>{t('controls.t_look')}</b> {t('controls.t_look_d')}</div>
              <div className="card"><b>{t('controls.t_build')}</b> {t('controls.t_build_d')}</div>
              <div className="card"><b>{t('controls.t_break')}</b> {t('controls.t_break_d')}</div>
              <div className="card"><b>{t('controls.t_block')}</b> {t('controls.t_block_d')}</div>
            </div>
          ) : (
            <div className="ctrlGrid">
              <div className="card"><b>{t('controls.move')}</b> {t('controls.move_keys')}</div>
              <div className="card"><b>{t('controls.jump')}</b> {t('controls.jump_keys')}</div>
              <div className="card"><b>{t('controls.fly_land')}</b> {t('controls.fly_land_keys')}</div>
              <div className="card"><b>{t('controls.look')}</b> {t('controls.look_keys')}</div>
              <div className="card"><b>{t('controls.break')}</b> {t('controls.break_keys')}</div>
              <div className="card"><b>{t('controls.build')}</b> {t('controls.build_keys')}</div>
              <div className="card"><b>{t('controls.pick_block')}</b> {t('controls.pick_block_keys')}</div>
              <div className="card"><b>{t('controls.hunt')}</b> {t('controls.hunt_keys')}</div>
              <div className="card"><b>{t('controls.fight')}</b> {t('controls.fight_keys')}</div>
              <div className="card"><b>{t('controls.collect')}</b> {t('controls.collect_keys')}</div>
              <div className="card"><b>{t('controls.your_face')}</b> {t('controls.your_face_keys')}</div>
              <div className="card"><b>{t('controls.peace_mode')}</b> {t('controls.peace_mode_keys')}</div>
              <div className="card"><b>{t('controls.structures')}</b> {t('controls.structures_keys')}</div>
              <div className="card"><b>{t('controls.show_controls')}</b> {t('controls.show_controls_keys')}</div>
            </div>
          )}
          <button id="closeControls">{t('controls.close')}</button>
        </div>
      </div>

      <div id="buildMenu" hidden>
        <div className="panel">
          <h2>{t('build.menu_title')}</h2>
          <p className="buildHint">{t('build.menu_hint')}</p>
          <div className="buildGrid">
            {STRUCTURE_KINDS.map((kind) => (
              <button key={kind} className="buildCard" data-kind={kind}>
                <span className="emoji">{STRUCTURE_DEFS[kind].emoji}</span>
                <span>{t(STRUCTURE_DEFS[kind].labelKey)}</span>
              </button>
            ))}
          </div>
          <button id="closeBuild">{t('build.close')}</button>
        </div>
      </div>

      <div id="start">
        <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 2 }}>
          <LocaleSwitcher />
        </div>
        <div className="startSky" aria-hidden="true">
          <span className="cloud cloud-a">☁️</span>
          <span className="cloud cloud-b">☁️</span>
          <span className="cloud cloud-c">☁️</span>
        </div>

        <div className="startHero">
          <img className="avatar" src={brand.image} alt={brand.name} />
          <h1>{brand.name}</h1>
          <p>{t('start.tagline')}</p>
          <div className="startBadges">
            <span className="record-badge" id="startRecord">{t('start.record')}</span>
            {lobbyAdmin && <span className="admin-badge" id="startAdmin">{t('lobby.admin_badge')}</span>}
            {lobbyModerator && <span className="admin-badge mod" id="startMod">{t('lobby.moderator_badge')}</span>}
            {offline && <span className="offline-badge" id="startOffline">{t('lobby.offline_badge')}</span>}
          </div>
        </div>

        <div className="startPanel">
          <LobbyPresence tenant={brand.id} roster={lobby.roster} />

          {(lobbyAdmin || lobbyModerator) && <LobbyAdmin lobby={lobby} />}

          <label id="nameField">
            {t('start.name_label')}
            <input
              id="nameInput"
              value={name}
              maxLength={16}
              placeholder={t('start.name_placeholder')}
              onChange={(e) => onNameChange(e.target.value)}
            />
          </label>
          {loggedIn && (
            <div id="sessionActions">
              <button id="logoutBtn" className="ghost" onClick={logout}>{t('login.logout')}</button>
            </div>
          )}

          <div id="lookField">
            <span className="lookTitle">{t('customize.title')}</span>
            <label>{t('customize.skin')}<input type="color" value={look.skin} onChange={(e) => onLookChange('skin', e.target.value)} /></label>
            <label>{t('customize.shirt')}<input type="color" value={look.shirt} onChange={(e) => onLookChange('shirt', e.target.value)} /></label>
            <label>{t('customize.hair')}<input type="color" value={look.hair} onChange={(e) => onLookChange('hair', e.target.value)} /></label>
          </div>

          <div id="modeField">
            <span className="modeTitle">{t('lobby.mode_label')}</span>
            <div id="modeToggle">
              <button
                className={solo ? '' : 'on'}
                disabled={modeGates.online.disabled}
                title={MODE_BLOCK_HINT_KEYS[modeGates.online.reason] ? t(MODE_BLOCK_HINT_KEYS[modeGates.online.reason]!) : undefined}
                onClick={() => { soloRef.current = false; setSolo(false); }}
              >
                {t('start.mode_multi')}
              </button>
              <button
                className={solo ? 'on' : ''}
                disabled={modeGates.offline.disabled}
                title={MODE_BLOCK_HINT_KEYS[modeGates.offline.reason] ? t(MODE_BLOCK_HINT_KEYS[modeGates.offline.reason]!) : undefined}
                onClick={() => { soloRef.current = true; setSolo(true); }}
              >
                {t('start.mode_solo')}
              </button>
            </div>
            {modeGates.online.disabled && MODE_BLOCK_HINT_KEYS[modeGates.online.reason] && (
              <span className="modeOfflineHint">{t(MODE_BLOCK_HINT_KEYS[modeGates.online.reason]!)}</span>
            )}
            {modeGates.offline.disabled && MODE_BLOCK_HINT_KEYS[modeGates.offline.reason] && (
              <span className="modeOfflineHint">{t(MODE_BLOCK_HINT_KEYS[modeGates.offline.reason]!)}</span>
            )}
          </div>

          <button id="playBtn">{t('start.play')}</button>

          <button
            id="startHelpBtn"
            className="ghost"
            onClick={() => { const c = document.getElementById('controls'); if (c) c.hidden = false; }}
          >
            {t('start.instructions')}
          </button>
        </div>

        <Leaderboard tenant={brand.id} />

        <footer id="startFooter">
          <a className="wantGame" href={rootHomeUrl(window.location.hostname)}>{t('lobby.want_game')}</a>
          <a className="credit" href={AUTHOR_URL} target="_blank" rel="noopener noreferrer">{t('lobby.credit')}</a>
        </footer>
      </div>
    </>
  );
}
