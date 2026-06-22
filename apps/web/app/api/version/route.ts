// Reports the currently deployed web build so open clients can detect a newer release and force an
// update. The loaded client compares its own NEXT_PUBLIC_APP_VERSION against this; when they differ
// (and neither is the local 'dev' build) the client surfaces a non-dismissable update screen.
import { DEFAULT_APP_VERSION } from '../../../lib/engine/constants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? DEFAULT_APP_VERSION;
  return Response.json({ version }, { headers: { 'Cache-Control': 'no-store' } });
}
