import { describe, expect, it, vi } from 'vitest';
import { createCoopWiring } from './coop-wiring';
import type { GameRuntime } from '../runtime';

function makeRuntime({ online, chatEnabled }: { online: boolean; chatEnabled: boolean }) {
  const onChat = vi.fn();
  const bind = vi.fn();
  const coopSendChat = vi.fn();
  const runtime = {
    state: { chatEnabled, player: { pos: {}, vel: { set: () => {} } } },
    brand: { id: 'acme' },
    coop: online ? { sendChat: coopSendChat } : null,
    bridge: { hud: { onChat }, resolveName: () => 'Alice', bind },
  } as unknown as GameRuntime;
  createCoopWiring(runtime);
  runtime.bindApi();
  return { api: bind.mock.calls[0][0], onChat, coopSendChat };
}

describe('createCoopWiring sendChat', () => {
  it('offline echoes the message locally under the player name', () => {
    const { api, onChat } = makeRuntime({ online: false, chatEnabled: true });
    api.sendChat('oi');
    expect(onChat).toHaveBeenCalledWith('Alice', 'oi');
  });

  it('online forwards to the server and does not echo locally', () => {
    const { api, onChat, coopSendChat } = makeRuntime({ online: true, chatEnabled: true });
    api.sendChat('oi');
    expect(coopSendChat).toHaveBeenCalledWith('oi');
    expect(onChat).not.toHaveBeenCalled();
  });

  it('drops the message when room chat is disabled', () => {
    const { api, onChat, coopSendChat } = makeRuntime({ online: false, chatEnabled: false });
    api.sendChat('oi');
    expect(onChat).not.toHaveBeenCalled();
    expect(coopSendChat).not.toHaveBeenCalled();
  });
});
