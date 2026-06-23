// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LocaleSwitcher from './LocaleSwitcher';

const assign = vi.fn();

function setLocation(pathname: string, search = '') {
  Object.defineProperty(window, 'location', {
    value: { pathname, search, assign },
    writable: true,
  });
}

afterEach(() => {
  cleanup();
  document.cookie = 'bl-locale=; path=/; max-age=0';
});

describe('LocaleSwitcher', () => {
  beforeEach(() => {
    assign.mockClear();
  });

  it('marks the URL-prefixed locale as the active option', () => {
    setLocation('/en-us/admin');
    render(<LocaleSwitcher />);
    expect(screen.getByRole('button', { name: 'EN' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'PT' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('navigates to the same path under the other prefix and keeps the query string', () => {
    setLocation('/pt-br/admin', '?tab=bans');
    render(<LocaleSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'EN' }));
    expect(assign).toHaveBeenCalledWith('/en-us/admin?tab=bans');
  });

  it('maps the localized root cleanly (no double slash)', () => {
    setLocation('/pt-br');
    render(<LocaleSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'EN' }));
    expect(assign).toHaveBeenCalledWith('/en-us');
  });

  it('persists the chosen locale in the bl-locale cookie', () => {
    setLocation('/pt-br/welcome');
    render(<LocaleSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'EN' }));
    expect(document.cookie).toContain('bl-locale=en-US');
  });

  it('does nothing when clicking the already-active locale', () => {
    setLocation('/pt-br/welcome');
    render(<LocaleSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'PT' }));
    expect(assign).not.toHaveBeenCalled();
  });
});
