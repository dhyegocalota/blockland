import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../lib/api', () => ({
  fetchChatLog: vi.fn(),
}));

import { POST } from './route';
import { fetchChatLog } from '../../../../../lib/api';

const fetchChatLogMock = vi.mocked(fetchChatLog);

afterEach(() => vi.clearAllMocks());

function post(tenant: string, body: unknown) {
  return POST(new Request('http://x/api/admin/chatlog/acme', { method: 'POST', body: JSON.stringify(body) }), {
    params: { tenant },
  });
}

describe('POST /api/admin/chatlog/[tenant]', () => {
  it('forwards the tenant + claim and returns the chat rows', async () => {
    fetchChatLogMock.mockResolvedValue([{ name: 'Ann', text: 'hi', sent_at: 5 }]);

    const res = await post('acme', { claim: 'tok' });

    expect(fetchChatLogMock).toHaveBeenCalledWith({ tenant: 'acme', claim: 'tok' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: 'Ann', text: 'hi', sent_at: 5 }]);
  });

  it('rejects a missing claim without calling the proxy', async () => {
    const res = await post('acme', {});

    expect(fetchChatLogMock).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });

  it('maps an upstream failure to a 502', async () => {
    fetchChatLogMock.mockRejectedValue(new Error('boom'));

    const res = await post('acme', { claim: 'tok' });

    expect(res.status).toBe(502);
  });
});
