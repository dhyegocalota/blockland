'use client';

// The room-admin controls surfaced on the lobby/start screen: a logged-in parent manages their
// world (peace, pvp, chat, structures, world reset, roster kick/ban/roles) over a headless server
// connection without entering the 3D game. Mirrors the in-game #adminPanel; the connection + state
// live in useLobbyAdmin (wired in use-game), this is just the markup.
import { t } from '../lib/i18n';
import { STRUCTURE_DEFS, STRUCTURE_KINDS } from '../lib/engine/structures';
import { roleBadge } from '../lib/roster-roles';
import AdminLimits from './AdminLimits';
import LobbyReports from './LobbyReports';
import { useLobbyReports } from '../hooks/use-lobby-reports';
import type { useLobbyAdmin } from '../hooks/use-lobby-admin';

export default function LobbyAdmin({ lobby }: { lobby: ReturnType<typeof useLobbyAdmin> }) {
  const reportViewer = useLobbyReports();
  const {
    state, roster, room, isAdmin, isModerator, resetArmed, resetWorld, resetScoresArmed, resetScores, clearHistoryArmed, clearHistory, suspendRoom,
    toggleRoomPeace, toggleRoomPvp, toggleRoomChat, toggleStructure, kickPlayer, banPlayer, setRole,
    pendingApprovals, toggleApprovalRequired, approvePlayer, rejectPlayer, banPending, bans, unban,
    setLimits, toggleOnlineAllowed, toggleOfflineAllowed,
  } = lobby;

  if (!isAdmin && !isModerator) {
    if (state === 'connecting' || state === 'reconnecting') {
      return <div id="lobbyAdmin" className="connecting">{t('lobby.admin_connecting')}</div>;
    }
    return null;
  }

  return (
    <div id="lobbyAdmin">
      <span className="lobbyAdminTitle">{t('lobby.admin_title')}</span>
      <div id="lobbyAdminBody">
        <button id="adminPeace" className={room.peace ? undefined : 'on'} onClick={toggleRoomPeace}>
          {room.peace ? t('game_admin.monsters_calm') : t('game_admin.monsters_attack')}
        </button>
        <button id="adminPvp" className={room.pvp ? 'on' : undefined} onClick={toggleRoomPvp}>
          {room.pvp ? t('game_admin.pvp_on') : t('game_admin.pvp_off')}
        </button>
        {isAdmin && (
          <button id="adminChat" className={room.chatEnabled ? undefined : 'on'} onClick={toggleRoomChat}>
            {room.chatEnabled ? t('game_admin.chat_on') : t('game_admin.chat_off')}
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
                  {(isAdmin || (isModerator && !player.admin)) && <button className="kick" onClick={() => kickPlayer(player.id)}>{t('game_admin.kick')}</button>}
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
                <button className={blocked ? 'blocked' : 'allowed'} onClick={() => toggleStructure(kind, blocked)}>
                  {blocked ? t('game_admin.blocked') : t('game_admin.allowed')}
                </button>
              </li>
            );
          })}
        </ul>
        {isAdmin && (
          <button id="adminApproval" className={room.approvalRequired ? 'on' : undefined} onClick={toggleApprovalRequired}>
            {room.approvalRequired ? t('game_admin.approval_on') : t('game_admin.approval_off')}
          </button>
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
                    <button className="ban" onClick={() => banPending(entry.accountId)}>{t('game_admin.ban')}</button>
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
          <button id="adminPlaytimeReport" onClick={() => reportViewer.open('playtime')}>
            {t('report.playtime_button')}
          </button>
        )}
        {isAdmin && (
          <button id="adminChatReport" onClick={() => reportViewer.open('chat')}>
            {t('report.chat_button')}
          </button>
        )}
        {isAdmin && reportViewer.report && (
          <LobbyReports report={reportViewer.report} close={reportViewer.close} />
        )}
        {isAdmin && (
          <AdminLimits
            room={room}
            setLimits={setLimits}
            toggleOnlineAllowed={toggleOnlineAllowed}
            toggleOfflineAllowed={toggleOfflineAllowed}
          />
        )}
        {isAdmin && (
          <button id="adminReset" className={resetArmed ? 'armed' : undefined} onClick={resetWorld}>
            {resetArmed ? t('game_admin.reset_confirm') : t('game_admin.reset')}
          </button>
        )}
        {isAdmin && (
          <button id="adminResetScores" className={resetScoresArmed ? 'armed' : undefined} onClick={resetScores}>
            {resetScoresArmed ? t('game_admin.reset_scores_confirm') : t('game_admin.reset_scores')}
          </button>
        )}
        {isAdmin && (
          <button id="adminClearHistory" className={clearHistoryArmed ? 'armed' : undefined} onClick={clearHistory}>
            {clearHistoryArmed ? t('game_admin.clear_history_confirm') : t('game_admin.clear_history')}
          </button>
        )}
        {isAdmin && (
          <button id="adminSuspend" className={room.suspended ? 'on' : undefined} onClick={suspendRoom}>
            {room.suspended ? t('game_admin.resume') : t('game_admin.suspend')}
          </button>
        )}
      </div>
    </div>
  );
}
