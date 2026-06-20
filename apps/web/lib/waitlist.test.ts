import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ signedFetch: vi.fn() }));

import { isValidEmail, joinWaitlist } from './waitlist';
import { signedFetch } from './api';

const signedFetchMock = vi.mocked(signedFetch);

function res(status: number): Response {
  return new Response(null, { status });
}

afterEach(() => vi.clearAllMocks());

describe('isValidEmail', () => {
  it('accepts a normal address, ignoring surrounding spaces', () => {
    expect(isValidEmail('  maria@email.com ')).toBe(true);
  });

  it('rejects blanks, missing parts, and malformed domains', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('maria')).toBe(false);
    expect(isValidEmail('@email.com')).toBe(false);
    expect(isValidEmail('maria@')).toBe(false);
    expect(isValidEmail('maria@email')).toBe(false);
    expect(isValidEmail('maria@email.')).toBe(false);
    expect(isValidEmail('a@@b.com')).toBe(false);
  });

  it('rejects an address past the max length', () => {
    const long = `${'a'.repeat(250)}@b.com`;
    expect(isValidEmail(long)).toBe(false);
  });
});

describe('joinWaitlist', () => {
  it('posts the entry to the internal route', async () => {
    signedFetchMock.mockResolvedValue(res(200));
    await joinWaitlist({ email: 'maria@email.com', name: 'Maria', phone: null });
    expect(signedFetchMock).toHaveBeenCalledWith('POST', '/internal/waitlist', {
      email: 'maria@email.com',
      name: 'Maria',
      phone: null,
    });
  });

  it('throws when the backend rejects the join', async () => {
    signedFetchMock.mockResolvedValue(res(500));
    await expect(
      joinWaitlist({ email: 'maria@email.com', name: null, phone: null }),
    ).rejects.toThrow('waitlist: join failed (500)');
  });
});
