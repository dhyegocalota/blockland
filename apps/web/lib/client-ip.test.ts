import { describe, expect, it } from 'vitest';
import { clientIp } from './client-ip';

const reqWith = (headers: Record<string, string>): Request => new Request('https://x.test', { headers });

describe('clientIp', () => {
  it('prefers the Cloudflare connecting-ip header', () => {
    const req = reqWith({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' });
    expect(clientIp(req)).toBe('9.9.9.9');
  });

  it('falls back to the first x-forwarded-for entry', () => {
    const req = reqWith({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' });
    expect(clientIp(req)).toBe('203.0.113.7');
  });

  it('is null when no proxy header is present', () => {
    expect(clientIp(reqWith({}))).toBeNull();
  });

  it('is null when the forwarded header is blank', () => {
    expect(clientIp(reqWith({ 'x-forwarded-for': '  ' }))).toBeNull();
  });
});
