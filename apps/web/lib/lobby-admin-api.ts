// Adapts the headless lobby NetClient into the RoomAdminApi surface so the existing useRoomAdmin
// dispatch (toggles, kick/ban, role, two-step reset) drives the lobby connection unchanged. Pure
// wiring, no React or DOM — fully unit-tested.

import type { RoomAdminApi } from './game-engine';
import type { NetClient } from './net';

export function lobbyAdminApi(net: NetClient): RoomAdminApi {
  return {
    setAdminPeace: (on) => net.sendAdminSetPeace(on),
    setAdminStructure: (kind, allowed) => net.sendAdminSetStructure(kind, allowed),
    setAdminPvp: (on) => net.sendAdminSetPvp(on),
    setAdminChat: (on) => net.sendAdminSetChat(on),
    kickPlayer: (id) => net.sendAdminKick(id),
    banPlayer: (id) => net.sendAdminBan(id),
    resetWorld: () => net.sendAdminResetWorld(),
    resetScores: () => net.sendAdminResetScores(),
    clearHistory: () => net.sendAdminClearHistory(),
    suspendRoom: (on) => net.sendAdminSuspend(on),
    setRole: (id, role) => net.sendAdminSetRole(id, role),
    setApprovalRequired: (on) => net.sendAdminSetApproval(on),
    approvePlayer: (accountId) => net.sendAdminApprove(accountId),
    rejectPlayer: (accountId) => net.sendAdminReject(accountId),
    banPending: (accountId) => net.sendAdminBanPending(accountId),
    unban: (ip) => net.sendAdminUnban(ip),
    setLimits: (min, hours) => net.sendAdminSetLimits(min, hours),
    setModes: (online, offline) => net.sendAdminSetModes(online, offline),
  };
}
