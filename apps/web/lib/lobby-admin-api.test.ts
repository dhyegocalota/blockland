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
    sendAdminReject: record('sendAdminReject'),
    sendAdminBanPending: record('sendAdminBanPending'),
    sendAdminUnban: record('sendAdminUnban'),
    sendAdminSetRole: record('sendAdminSetRole'),
    sendAdminSetLimits: record('sendAdminSetLimits'),
    sendAdminSetModes: record('sendAdminSetModes'),
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
    api.rejectPlayer('acc2');
    api.banPending('ip:1.2.3.4');
    api.unban('1.2.3.4');
    api.setLimits(5, 24);
    api.setModes(false, true);

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
      ['sendAdminReject', 'acc2'],
      ['sendAdminBanPending', 'ip:1.2.3.4'],
      ['sendAdminUnban', '1.2.3.4'],
      ['sendAdminSetLimits', 5, 24],
      ['sendAdminSetModes', false, true],
    ]);
  });
});
