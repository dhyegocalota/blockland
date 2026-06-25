// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
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

  it('re-polls presence on the fast interval so the lobby count stays near-real-time', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ count: 1, names: ['Maria'], suspended: false }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      render(<LobbyPresence tenant="acme" roster={[]} />);
      await act(async () => { await Promise.resolve(); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
