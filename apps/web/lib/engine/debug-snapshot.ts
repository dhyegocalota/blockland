// Pure assembly of the F3 debug overlay: fps and coordinates are rounded, the chunk count and tenant
// pass through, and the network fields come from the live co-op connection or read "offline" when
// solo. The engine reads the raw numbers off three.js/coop; turning them into the snapshot is here.

import { roundCoordinate } from './scoreboard';

export interface DebugSnapshot {
  fps: number;
  ping: number;
  state: string;
  online: number;
  x: number;
  y: number;
  z: number;
  chunks: number;
  tenant: string;
}

export interface CoopStatus {
  ping: number;
  state: string;
  onlineCount: number;
}

export const OFFLINE_STATE = 'offline';
export const OFFLINE_ONLINE = 1;

export function buildDebugSnapshot({
  fps, x, y, z, chunks, tenant, coop,
}: {
  fps: number;
  x: number;
  y: number;
  z: number;
  chunks: number;
  tenant: string;
  coop: CoopStatus | null;
}): DebugSnapshot {
  const base = {
    fps: Math.round(fps),
    x: roundCoordinate(x), y: roundCoordinate(y), z: roundCoordinate(z),
    chunks,
    tenant,
  };
  if (!coop) return { ...base, ping: 0, state: OFFLINE_STATE, online: OFFLINE_ONLINE };
  return { ...base, ping: coop.ping, state: coop.state, online: coop.onlineCount };
}
