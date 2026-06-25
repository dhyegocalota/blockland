// The caller's real IP from the proxy/CDN headers (Cloudflare first, then a generic forwarded list).
// Used as Turnstile's remote-ip on form submissions. Null when no proxy header is present (local dev).
export function clientIp(req: Request): string | null {
  const cloudflare = req.headers.get('cf-connecting-ip');
  const forwarded = cloudflare ?? req.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const first = forwarded.split(',')[0].trim();
  return first.length > 0 ? first : null;
}
