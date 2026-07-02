// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@vercel/analytics/next', () => ({ Analytics: () => <div data-testid="analytics" /> }));

import CookieConsent from './CookieConsent';
import { COOKIE_CONSENT_KEY, COOKIE_SETTINGS_EVENT } from '../lib/cookie-consent';

afterEach(() => { cleanup(); document.cookie = `${COOKIE_CONSENT_KEY}=; path=/; max-age=0`; });

function banner() { return document.querySelector('[aria-label="Cookie consent"]'); }

describe('CookieConsent', () => {
  it('shows the banner and loads no analytics until a choice is made', () => {
    render(<CookieConsent />);
    expect(banner()).toBeInTheDocument();
    expect(screen.queryByTestId('analytics')).toBeNull();
  });

  it('accepting hides the banner, remembers the choice and loads analytics', () => {
    render(<CookieConsent />);
    fireEvent.click(screen.getByText('Aceitar todos'));
    expect(banner()).toBeNull();
    expect(document.cookie).toContain(`${COOKIE_CONSENT_KEY}=accepted`);
    expect(screen.getByTestId('analytics')).toBeInTheDocument();
  });

  it('essential-only hides the banner and keeps analytics off', () => {
    render(<CookieConsent />);
    fireEvent.click(screen.getByText('Só os essenciais'));
    expect(banner()).toBeNull();
    expect(document.cookie).toContain(`${COOKIE_CONSENT_KEY}=essential`);
    expect(screen.queryByTestId('analytics')).toBeNull();
  });

  it('does not show the banner again on a later mount once decided', () => {
    render(<CookieConsent />);
    fireEvent.click(screen.getByText('Aceitar todos'));
    cleanup();
    render(<CookieConsent />);
    expect(banner()).toBeNull();
    expect(screen.getByTestId('analytics')).toBeInTheDocument();
  });

  it('reopens on the manage-cookies event so consent can be changed or withdrawn', () => {
    render(<CookieConsent />);
    fireEvent.click(screen.getByText('Aceitar todos'));
    expect(banner()).toBeNull();
    act(() => { window.dispatchEvent(new Event(COOKIE_SETTINGS_EVENT)); });
    expect(banner()).toBeInTheDocument();
    fireEvent.click(screen.getByText('Só os essenciais'));
    expect(banner()).toBeNull();
    expect(document.cookie).toContain(`${COOKIE_CONSENT_KEY}=essential`);
    expect(screen.queryByTestId('analytics')).toBeNull();
  });
});
