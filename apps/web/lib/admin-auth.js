// Fixed admin secret check. Set ADMIN_KEY in the environment for production.
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-secret';

export function isAdmin(req) {
  const key = req.headers.get('x-admin-key');
  return typeof key === 'string' && key.length > 0 && key === ADMIN_KEY;
}
