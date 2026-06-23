// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import LobbyReports from './LobbyReports';

afterEach(cleanup);

const noop = () => undefined;

describe('LobbyReports', () => {
  it('labels the hours-played report as the last 30 days', () => {
    const { getByText } = render(
      <LobbyReports
        report={{
          kind: 'playtime',
          loading: false,
          failed: false,
          playtime: [{ key: 'acc1', used_ms: 3_600_000 }],
          chat: [],
        }}
        close={noop}
      />,
    );
    expect(getByText('📊 Horas jogadas')).toBeInTheDocument();
    expect(getByText('Últimos 30 dias')).toBeInTheDocument();
  });

  it('labels the chat report as the last 30 days', () => {
    const { getByText } = render(
      <LobbyReports
        report={{
          kind: 'chat',
          loading: false,
          failed: false,
          playtime: [],
          chat: [{ name: 'Kid', text: 'hi', sent_at: Date.now() }],
        }}
        close={noop}
      />,
    );
    expect(getByText('💬 Chat')).toBeInTheDocument();
    expect(getByText('Últimos 30 dias')).toBeInTheDocument();
  });
});
