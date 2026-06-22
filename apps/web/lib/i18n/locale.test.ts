import { describe, expect, it } from 'vitest';
import {
  localeFromAcceptLanguage,
  localeOfPrefix,
  localePrefix,
  preferredLocale,
  splitLocalePrefix,
} from './locale';

describe('localePrefix / localeOfPrefix', () => {
  it('maps locales to lowercase URL prefixes and back', () => {
    expect(localePrefix('pt-BR')).toBe('pt-br');
    expect(localePrefix('en-US')).toBe('en-us');
    expect(localeOfPrefix('pt-br')).toBe('pt-BR');
    expect(localeOfPrefix('EN-US')).toBe('en-US');
  });

  it('returns null for an unknown prefix', () => {
    expect(localeOfPrefix('admin')).toBeNull();
    expect(localeOfPrefix('fr')).toBeNull();
  });
});

describe('splitLocalePrefix', () => {
  it('splits a prefixed path into locale + rest', () => {
    expect(splitLocalePrefix('/en-us/admin')).toEqual({ locale: 'en-US', rest: '/admin' });
    expect(splitLocalePrefix('/pt-br/welcome')).toEqual({ locale: 'pt-BR', rest: '/welcome' });
  });

  it('treats a bare locale prefix as the root path', () => {
    expect(splitLocalePrefix('/en-us')).toEqual({ locale: 'en-US', rest: '/' });
  });

  it('returns null when the first segment is not a locale', () => {
    expect(splitLocalePrefix('/admin')).toBeNull();
    expect(splitLocalePrefix('/')).toBeNull();
  });
});

describe('localeFromAcceptLanguage', () => {
  it('defaults to pt-BR when the header is empty', () => {
    expect(localeFromAcceptLanguage(null)).toBe('pt-BR');
    expect(localeFromAcceptLanguage('')).toBe('pt-BR');
  });

  it('picks en-US when English is preferred', () => {
    expect(localeFromAcceptLanguage('en-US,en;q=0.9')).toBe('en-US');
    expect(localeFromAcceptLanguage('en-GB,en;q=0.8,pt;q=0.5')).toBe('en-US');
  });

  it('picks pt-BR when Portuguese is preferred', () => {
    expect(localeFromAcceptLanguage('pt-BR,pt;q=0.9,en;q=0.5')).toBe('pt-BR');
  });

  it('honors quality weights over header order', () => {
    expect(localeFromAcceptLanguage('en;q=0.4,pt;q=0.9')).toBe('pt-BR');
  });

  it('defaults to pt-BR for unsupported languages', () => {
    expect(localeFromAcceptLanguage('fr-FR,de;q=0.8')).toBe('pt-BR');
  });
});

describe('preferredLocale', () => {
  it('honors a valid cookie above Accept-Language', () => {
    expect(preferredLocale({ cookie: 'en-US', acceptLanguage: 'pt-BR' })).toBe('en-US');
  });

  it('ignores an invalid cookie and falls back to Accept-Language', () => {
    expect(preferredLocale({ cookie: 'xx', acceptLanguage: 'en-US,en;q=0.9' })).toBe('en-US');
  });

  it('falls back to the pt-BR default when nothing matches', () => {
    expect(preferredLocale({ cookie: null, acceptLanguage: null })).toBe('pt-BR');
  });
});
