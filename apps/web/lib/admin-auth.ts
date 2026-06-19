// Fixed admin secret check. Set ADMIN_KEY in the environment for production.
import { timingSafeEqual } from 'node:crypto';

const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-secret';

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isAdmin(req: Request): boolean {
  const key = req.headers.get('x-admin-key');
  if (typeof key !== 'string' || key.length === 0) return false;
  return constantTimeEqual(key, ADMIN_KEY);
}
