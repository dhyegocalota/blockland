// Fixed admin secret check. Set ADMIN_KEY in the environment; every admin request is rejected when it
// is unset, so a deploy without the secret fails closed instead of falling back to a known default.
import { timingSafeEqual } from 'node:crypto';

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isAdmin(req: Request): boolean {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return false;
  const key = req.headers.get('x-admin-key');
  if (typeof key !== 'string' || key.length === 0) return false;
  return constantTimeEqual(key, adminKey);
}
