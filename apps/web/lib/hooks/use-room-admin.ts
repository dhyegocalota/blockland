import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import type { RoomState } from '../coop';
import type { GameApi } from '../game-engine';
import type { Role } from '../protocol';

// World reset is destructive, so the first click only arms it; the admin must confirm within this
// window or it disarms itself — a misclick can never wipe the world.
const RESET_ARM_MS = 4000;

const DEFAULT_ROOM: RoomState = { peace: true, blockedStructures: [], pvp: false, chatEnabled: true, suspended: false };

// Owns the room settings + admin authority the engine reports (setRoom/setIsAdmin feed the bridge),
// the admin panel open state, and the admin command dispatch incl. the two-step world reset.
export function useRoomAdmin(gameApi: MutableRefObject<GameApi | null>) {
  const [room, setRoom] = useState<RoomState>(DEFAULT_ROOM);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isModerator, setIsModerator] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const resetArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [resetScoresArmed, setResetScoresArmed] = useState(false);
  const resetScoresArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleRoomPeace = useCallback(() => gameApi.current?.setAdminPeace(!room.peace), [gameApi, room.peace]);
  const toggleStructure = useCallback(
    (kind: string, allowed: boolean) => gameApi.current?.setAdminStructure(kind, allowed),
    [gameApi],
  );
  const toggleRoomPvp = useCallback(() => gameApi.current?.setAdminPvp(!room.pvp), [gameApi, room.pvp]);
  const toggleRoomChat = useCallback(
    () => gameApi.current?.setAdminChat(!room.chatEnabled),
    [gameApi, room.chatEnabled],
  );
  const kickPlayer = useCallback((id: number) => gameApi.current?.kickPlayer(id), [gameApi]);
  const banPlayer = useCallback((id: number) => gameApi.current?.banPlayer(id), [gameApi]);
  const setRole = useCallback((id: number, role: Role) => gameApi.current?.setRole(id, role), [gameApi]);
  const suspendRoom = useCallback(() => gameApi.current?.suspendRoom(!room.suspended), [gameApi, room.suspended]);

  const resetWorld = useCallback(() => {
    if (!resetArmed) {
      setResetArmed(true);
      if (resetArmTimer.current) clearTimeout(resetArmTimer.current);
      resetArmTimer.current = setTimeout(() => setResetArmed(false), RESET_ARM_MS);
      return;
    }
    if (resetArmTimer.current) clearTimeout(resetArmTimer.current);
    setResetArmed(false);
    gameApi.current?.resetWorld();
  }, [gameApi, resetArmed]);

  const resetScores = useCallback(() => {
    if (!resetScoresArmed) {
      setResetScoresArmed(true);
      if (resetScoresArmTimer.current) clearTimeout(resetScoresArmTimer.current);
      resetScoresArmTimer.current = setTimeout(() => setResetScoresArmed(false), RESET_ARM_MS);
      return;
    }
    if (resetScoresArmTimer.current) clearTimeout(resetScoresArmTimer.current);
    setResetScoresArmed(false);
    gameApi.current?.resetScores();
  }, [gameApi, resetScoresArmed]);

  return {
    room,
    setRoom,
    isAdmin,
    setIsAdmin,
    isModerator,
    setIsModerator,
    adminOpen,
    setAdminOpen,
    resetArmed,
    resetWorld,
    resetScoresArmed,
    resetScores,
    toggleRoomPeace,
    toggleStructure,
    toggleRoomPvp,
    toggleRoomChat,
    kickPlayer,
    banPlayer,
    setRole,
    suspendRoom,
  };
}
