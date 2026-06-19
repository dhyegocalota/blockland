// Public: top scores for a tenant's leaderboard. Read-only and identical for every visitor, so it is
// double-cached: a short in-process TTL cache absorbs bursts and a Cache-Control header lets the CDN
// serve it. Validates the tenant + window params and caps the list to the top N.
import { topScores, type LeaderboardWindow } from '../../../../lib/api';
import { readCache, writeCache } from '../../../../lib/leaderboard-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOP_LIMIT = 10;
const CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=120';

function parseWindow(value: string | null): LeaderboardWindow {
  return value === 'month' ? 'month' : 'all';
}

export async function GET(req: Request, { params }: { params: { tenant: string } }) {
  const tenant = params.tenant.trim();
  if (tenant === '') {
    return Response.json({ error: 'invalid_tenant' }, { status: 400 });
  }
  const window = parseWindow(new URL(req.url).searchParams.get('window'));
  const cacheKey = `${tenant}:${window}`;
  const now = Date.now();

  const cached = readCache(cacheKey, now);
  if (cached) {
    return Response.json(cached, { headers: { 'cache-control': CACHE_CONTROL } });
  }

  const scores = (await topScores({ tenant, window, limit: TOP_LIMIT })).slice(0, TOP_LIMIT);
  writeCache(cacheKey, scores, now);
  console.log('[api:leaderboard] top', { tenant, window, count: scores.length });
  return Response.json(scores, { headers: { 'cache-control': CACHE_CONTROL } });
}
