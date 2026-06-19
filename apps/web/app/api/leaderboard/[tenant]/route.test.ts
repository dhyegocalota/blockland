import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/api', () => ({
  topScores: vi.fn(),
}));

import { GET } from './route';
import { topScores } from '../../../../lib/api';
import { clearCache } from '../../../../lib/leaderboard-cache';

const topScoresMock = vi.mocked(topScores);

beforeEach(() => clearCache());
afterEach(() => vi.clearAllMocks());

describe('GET /api/leaderboard/[tenant]', () => {
  it('returns the all-time top scores with a cache-control header', async () => {
    topScoresMock.mockResolvedValue([{ name: 'Ann', score: 30 }]);

    const res = await GET(new Request('http://x/api/leaderboard/teo'), { params: { tenant: 'teo' } });

    expect(topScoresMock).toHaveBeenCalledWith({ tenant: 'teo', window: 'all', limit: 10 });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=60, stale-while-revalidate=120');
    expect(await res.json()).toEqual([{ name: 'Ann', score: 30 }]);
  });

  it('passes window=month through for the last-30-days board', async () => {
    topScoresMock.mockResolvedValue([{ name: 'Bo', score: 9 }]);

    await GET(new Request('http://x/api/leaderboard/teo?window=month'), { params: { tenant: 'teo' } });

    expect(topScoresMock).toHaveBeenCalledWith({ tenant: 'teo', window: 'month', limit: 10 });
  });

  it('serves a second identical request from cache without re-hitting the proxy', async () => {
    topScoresMock.mockResolvedValue([{ name: 'Ann', score: 30 }]);

    await GET(new Request('http://x/api/leaderboard/teo'), { params: { tenant: 'teo' } });
    await GET(new Request('http://x/api/leaderboard/teo'), { params: { tenant: 'teo' } });

    expect(topScoresMock).toHaveBeenCalledTimes(1);
  });

  it('caps the list to the top 10', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `P${i}`, score: 25 - i }));
    topScoresMock.mockResolvedValue(many);

    const res = await GET(new Request('http://x/api/leaderboard/teo'), { params: { tenant: 'teo' } });

    expect((await res.json()) as unknown[]).toHaveLength(10);
  });

  it('rejects an empty tenant without calling the proxy', async () => {
    const res = await GET(new Request('http://x/api/leaderboard/'), { params: { tenant: '  ' } });

    expect(topScoresMock).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });
});
