// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LobbyPresence from './LobbyPresence';

afterEach(cleanup);

describe('LobbyPresence', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing while nobody is online', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 0, names: [], suspended: false }) }),
    );
    const { container } = render(<LobbyPresence tenant="acme" roster={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists the online players once presence loads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 2, names: ['Maria', 'Joao'], suspended: false }) }),
    );
    const { container } = render(<LobbyPresence tenant="acme" roster={[]} />);
    await waitFor(() => expect(container.querySelector('#lobbyPresence')).toBeInTheDocument());
    expect(container.querySelector('.names')?.textContent).toContain('Maria');
    expect(container.querySelector('.names')?.textContent).toContain('Joao');
  });
});
