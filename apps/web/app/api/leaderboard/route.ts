// Public: submit a score and return the updated top scores.
import { submitScore, topScores } from '../../../lib/leaderboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_MAX_LENGTH = 16;

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const tenant = String(body.tenant || '').trim();
  if (tenant === '') {
    return Response.json({ error: 'invalid_tenant' }, { status: 400 });
  }

  if (typeof body.name !== 'string') {
    return Response.json({ error: 'invalid_name' }, { status: 400 });
  }
  const name = body.name.trim().slice(0, NAME_MAX_LENGTH);
  if (name === '') {
    return Response.json({ error: 'invalid_name' }, { status: 400 });
  }

  const score = body.score;
  if (typeof score !== 'number' || !Number.isInteger(score) || !Number.isFinite(score) || score < 0) {
    return Response.json({ error: 'invalid_score' }, { status: 400 });
  }

  await submitScore({ tenant, name, score });
  const scores = await topScores(tenant);
  console.log('[api:leaderboard] submit', { tenant, name, score });
  return Response.json(scores);
}
