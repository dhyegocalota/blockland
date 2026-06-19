import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/api', () => ({
  topScores: vi.fn(),
}));

import { GET } from './route';
import { topScores } from '../../../../lib/api';

const topScoresMock = vi.mocked(topScores);

afterEach(() => vi.clearAllMocks());

describe('GET /api/leaderboard/[tenant]', () => {
  it('returns the top scores from the api proxy', async () => {
    topScoresMock.mockResolvedValue([{ name: 'Ann', score: 30 }]);

    const res = await GET(new Request('http://x/api/leaderboard/teo'), { params: { tenant: 'teo' } });

    expect(topScoresMock).toHaveBeenCalledWith('teo');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: 'Ann', score: 30 }]);
  });

  it('rejects an empty tenant without calling the proxy', async () => {
    const res = await GET(new Request('http://x/api/leaderboard/'), { params: { tenant: '  ' } });

    expect(topScoresMock).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });
});
