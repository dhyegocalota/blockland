'use client';

// Headless lobby admin connection: opens a NetClient (no three.js, no rendering) so a logged-in
// admin/moderator can manage their world from the start screen — the same admin commands and
// room/roster updates the in-game panel uses, without joining the 3D world. Reuses useRoomAdmin for
// the dispatch + two-step reset; the NetClient is adapted into its RoomAdminApi via lobbyAdminApi.
import { useEffect, useRef, useState } from 'react';
import { loadSession } from '../lib/session';
import { createNet, type NetClient, type NetState } from '../lib/net';
import { MAIN_WORLD, type Appearance, type RoomState, type RosterEntry } from '../lib/coop';
import type { RoomAdminApi } from '../lib/game-engine';
import { lobbyAdminApi } from '../lib/lobby-admin-api';
import { useRoomAdmin } from './use-room-admin';
import { debug } from '../lib/log';

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL;

interface LobbyAdminParams {
  tenant: string | null;
  name: string;
  look: Appearance;
  active: boolean;
}

export function useLobbyAdmin({ tenant, name, look, active }: LobbyAdminParams) {
  const apiRef = useRef<RoomAdminApi | null>(null);
  const admin = useRoomAdmin(apiRef);
  const { setRoom, setIsAdmin, setIsModerator, setPendingApprovals, setBans } = admin;
  const [state, setState] = useState<NetState | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);

  useEffect(() => {
    if (!active) return;
    if (!tenant) return;
    if (!SERVER_URL) return;
    const session = loadSession();
    if (!session || session.tenant !== tenant) return;
    if (session.is_admin !== true && session.is_moderator !== true) return;

    let selfId: number | null = null;
    const names = new Map<number, { name: string; admin: boolean; moderator: boolean; pvpKills: number; away: boolean }>();
    const net: NetClient = createNet({
      url: SERVER_URL,
      tenant,
      world: MAIN_WORLD,
      name,
      skin: look.skin,
      shirt: look.shirt,
      hair: look.hair,
      claim: session.claim,
      reconnect: false,
      // A monitor connection: the server keeps this admin out of the roster/snapshot, so opening the
      // lobby panel never shows other players a phantom "joined the game".
      observer: true,
      handlers: {
        onState: (next) => setState(next),
        onWelcome: (msg) => {
          selfId = msg.you;
          setIsAdmin(msg.admin);
          setIsModerator(msg.moderator);
          debug('lobby-admin', 'welcome', { you: msg.you, admin: msg.admin, moderator: msg.moderator });
        },
        onSnapshot: (msg) => {
          setRoster(
            msg.players
              .filter((p) => names.has(p.id))
              .map((p) => {
                const identity = names.get(p.id)!;
                return { id: p.id, name: identity.name, self: p.id === selfId, admin: identity.admin, moderator: identity.moderator, pvpKills: identity.pvpKills, away: identity.away };
              }),
          );
        },
        onRoster: (msg) => {
          names.clear();
          for (const p of msg.players) names.set(p.id, { name: p.name, admin: p.admin, moderator: p.moderator, pvpKills: p.pvp_kills, away: p.away });
        },
        onRoomState: (msg) => {
          setRoom({
            peace: msg.peace,
            blockedStructures: msg.blocked_structures,
            pvp: msg.pvp,
            chatEnabled: msg.chat_enabled,
            suspended: msg.suspended,
            approvalRequired: msg.approval_required,
            playtimeLimitMin: msg.playtime_limit_min,
            playtimeWindowH: msg.playtime_window_h,
            onlineAllowed: msg.online_allowed,
            offlineAllowed: msg.offline_allowed,
          });
        },
        onRole: (msg) => { setIsAdmin(msg.admin); setIsModerator(msg.moderator); },
        onPendingApprovals: (msg) => {
          setPendingApprovals(msg.pending.map((p) => ({ accountId: p.account_id, name: p.name, email: p.email })));
        },
        onBans: (msg) => {
          setBans(msg.bans.map((b) => ({ ip: b.ip, name: b.name })));
        },
      },
    });
    apiRef.current = lobbyAdminApi(net);
    net.connect();
    debug('lobby-admin', 'connecting', { tenant, name });
    return () => {
      net.close();
      apiRef.current = null;
      setState(null);
      setRoster([]);
    };
  }, [active, tenant, name, look.skin, look.shirt, look.hair, setRoom, setIsAdmin, setIsModerator]);

  return { ...admin, state, roster };
}

export type LobbyRoomState = RoomState;
