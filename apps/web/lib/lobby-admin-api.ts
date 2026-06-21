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
    setRole: (id, role) => net.sendAdminSetRole(id, role),
  };
}
