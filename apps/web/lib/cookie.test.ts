// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ONE_YEAR_SECONDS, readCookie, writeCookie } from './cookie';

afterEach(() => {
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=')[0].trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
});

describe('cookie', () => {
  it('reads null for a cookie that is not set', () => {
    expect(readCookie('bl-missing')).toBeNull();
  });

  it('round-trips a value through write and read', () => {
    writeCookie('bl-choice', 'accepted');
    expect(readCookie('bl-choice')).toBe('accepted');
  });

  it('encodes and decodes values with reserved characters', () => {
    writeCookie('bl-choice', 'a; b=c');
    expect(readCookie('bl-choice')).toBe('a; b=c');
  });

  it('reads the right cookie when several are set', () => {
    writeCookie('bl-first', 'one');
    writeCookie('bl-second', 'two');
    expect(readCookie('bl-second')).toBe('two');
  });

  it('persists for a year', () => {
    expect(ONE_YEAR_SECONDS).toBe(31536000);
  });
});
