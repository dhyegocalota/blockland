import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../lib/api', () => ({
  fetchPlaytimeReport: vi.fn(),
}));

import { POST } from './route';
import { fetchPlaytimeReport } from '../../../../../lib/api';

const fetchPlaytimeReportMock = vi.mocked(fetchPlaytimeReport);

afterEach(() => vi.clearAllMocks());

function post(tenant: string, body: unknown) {
  return POST(new Request('http://x/api/admin/playtime/acme', { method: 'POST', body: JSON.stringify(body) }), {
    params: { tenant },
  });
}

describe('POST /api/admin/playtime/[tenant]', () => {
  it('forwards the tenant + claim and returns the report rows', async () => {
    fetchPlaytimeReportMock.mockResolvedValue([{ key: 'ann-id', used_ms: 1000 }]);

    const res = await post('acme', { claim: 'tok' });

    expect(fetchPlaytimeReportMock).toHaveBeenCalledWith({ tenant: 'acme', claim: 'tok' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ key: 'ann-id', used_ms: 1000 }]);
  });

  it('rejects a missing claim without calling the proxy', async () => {
    const res = await post('acme', {});

    expect(fetchPlaytimeReportMock).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });

  it('maps an upstream failure to a 502', async () => {
    fetchPlaytimeReportMock.mockRejectedValue(new Error('boom'));

    const res = await post('acme', { claim: 'tok' });

    expect(res.status).toBe(502);
  });
});
