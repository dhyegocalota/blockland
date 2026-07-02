// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { CONSENT_KEY, loadConsent, saveConsent } from './consent';

afterEach(() => { window.localStorage.clear(); });

describe('consent', () => {
  it('defaults to not accepted', () => {
    expect(loadConsent()).toBe(false);
  });

  it('remembers acceptance', () => {
    saveConsent(true);
    expect(loadConsent()).toBe(true);
  });

  it('can be revoked back to not accepted', () => {
    saveConsent(true);
    saveConsent(false);
    expect(loadConsent()).toBe(false);
  });

  it('treats a non-"true" stored value as not accepted', () => {
    window.localStorage.setItem(CONSENT_KEY, 'yes');
    expect(loadConsent()).toBe(false);
  });
});
