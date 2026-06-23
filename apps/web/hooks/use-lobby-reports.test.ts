// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLobbyReports } from './use-lobby-reports';
import { loadSession } from '../lib/session';

vi.mock('../lib/session', () => ({ loadSession: vi.fn() }));

const loadSessionMock = vi.mocked(loadSession);

afterEach(() => vi.restoreAllMocks());

function mockFetch() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('useLobbyReports', () => {
  it('fetches the chat report from /api/admin/chatlog (not /chat) so it does not 404', async () => {
    loadSessionMock.mockReturnValue({ tenant: 'acme', name: 'Maria', claim: 'tok', is_admin: true, is_moderator: false });
    const fetchMock = mockFetch();
    const { result } = renderHook(() => useLobbyReports());

    act(() => result.current.open('chat'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/chatlog/acme');
  });

  it('fetches the hours-played report from /api/admin/playtime', async () => {
    loadSessionMock.mockReturnValue({ tenant: 'acme', name: 'Maria', claim: 'tok', is_admin: true, is_moderator: false });
    const fetchMock = mockFetch();
    const { result } = renderHook(() => useLobbyReports());

    act(() => result.current.open('playtime'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/playtime/acme');
  });

  it('does nothing without a session', () => {
    loadSessionMock.mockReturnValue(null);
    const fetchMock = mockFetch();
    const { result } = renderHook(() => useLobbyReports());

    act(() => result.current.open('chat'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.report).toBeNull();
  });
});
