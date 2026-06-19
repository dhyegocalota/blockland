// Public: top scores for a tenant's leaderboard.
import { topScores } from '../../../../lib/leaderboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { tenant: string } }) {
  const tenant = params.tenant.trim();
  if (tenant === '') {
    return Response.json({ error: 'invalid_tenant' }, { status: 400 });
  }
  const scores = await topScores(tenant);
  console.log('[api:leaderboard] top', { tenant, count: scores.length });
  return Response.json(scores);
}
