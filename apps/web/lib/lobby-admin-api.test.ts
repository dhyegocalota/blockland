import { describe, expect, it } from 'vitest';
import { lobbyAdminApi } from './lobby-admin-api';
import type { NetClient } from './net';
import type { Role } from './protocol';

function recordingNet() {
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const net = {
    connect: record('connect'),
    close: record('close'),
    sendMove: record('sendMove'),
    sendEdit: record('sendEdit'),
    sendEditBatch: record('sendEditBatch'),
    sendChat: record('sendChat'),
    sendHit: record('sendHit'),
    sendRespawn: record('sendRespawn'),
    sendDig: record('sendDig'),
    sendAdminSetPeace: record('sendAdminSetPeace'),
    sendAdminSetStructure: record('sendAdminSetStructure'),
    sendAdminSetPvp: record('sendAdminSetPvp'),
    sendAdminSetChat: record('sendAdminSetChat'),
    sendAdminSetInfinite: record('sendAdminSetInfinite'),
    sendAdminKick: record('sendAdminKick'),
    sendAdminBan: record('sendAdminBan'),
    sendAttackPlayer: record('sendAttackPlayer'),
    sendAdminResetWorld: record('sendAdminResetWorld'),
    sendAdminResetScores: record('sendAdminResetScores'),
    sendAdminSuspend: record('sendAdminSuspend'),
    sendAdminSetApproval: record('sendAdminSetApproval'),
    sendAdminApprove: record('sendAdminApprove'),
    sendAdminSetRole: record('sendAdminSetRole'),
    ping: 0,
    state: 'online' as const,
  } satisfies NetClient;
  return { net, calls };
}

describe('lobbyAdminApi', () => {
  it('maps every admin command to the matching net send', () => {
    const { net, calls } = recordingNet();
    const api = lobbyAdminApi(net);

    api.setAdminPeace(false);
    api.setAdminPvp(true);
    api.setAdminChat(false);
    api.setAdminStructure('trophy', false);
    api.kickPlayer(7);
    api.banPlayer(9);
    api.setRole(3, 'moderator' as Role);
    api.resetWorld();
    api.resetScores();
    api.suspendRoom(true);
    api.setApprovalRequired(true);
    api.approvePlayer('acc1');

    expect(calls).toEqual([
      ['sendAdminSetPeace', false],
      ['sendAdminSetPvp', true],
      ['sendAdminSetChat', false],
      ['sendAdminSetStructure', 'trophy', false],
      ['sendAdminKick', 7],
      ['sendAdminBan', 9],
      ['sendAdminSetRole', 3, 'moderator'],
      ['sendAdminResetWorld'],
      ['sendAdminResetScores'],
      ['sendAdminSuspend', true],
      ['sendAdminSetApproval', true],
      ['sendAdminApprove', 'acc1'],
    ]);
  });
});
