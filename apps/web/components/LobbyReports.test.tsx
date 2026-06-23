// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LobbyReports from './LobbyReports';
import { REPORT_PAGE_SIZE } from '../lib/report-format';
import type { ChatEntry } from '../lib/api';

afterEach(cleanup);

const noop = () => undefined;

function chatReport(chat: ChatEntry[]) {
  return { kind: 'chat' as const, loading: false, failed: false, playtime: [], chat };
}

function manyChatLines(count: number): ChatEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Kid${index}`,
    text: `message ${index}`,
    sent_at: Date.now(),
  }));
}

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

  it('opens the chat report as a modal with rows and a pager', () => {
    const { getByText, getByRole, getAllByText } = render(
      <LobbyReports report={chatReport(manyChatLines(REPORT_PAGE_SIZE + 3))} close={noop} />,
    );
    expect(getByRole('dialog')).toBeInTheDocument();
    expect(getByText('💬 Chat')).toBeInTheDocument();
    expect(getByText('Últimos 30 dias')).toBeInTheDocument();
    expect(getByText('Página 1 de 2')).toBeInTheDocument();
    expect(getByText('Kid0')).toBeInTheDocument();
    expect(getAllByText(/^Kid/)).toHaveLength(REPORT_PAGE_SIZE);
  });

  it('pages forward and back with next/prev', () => {
    const { getByText, queryByText } = render(
      <LobbyReports report={chatReport(manyChatLines(REPORT_PAGE_SIZE + 1))} close={noop} />,
    );
    expect(queryByText(`Kid${REPORT_PAGE_SIZE}`)).not.toBeInTheDocument();

    fireEvent.click(getByText('Próxima ▶'));
    expect(getByText('Página 2 de 2')).toBeInTheDocument();
    expect(getByText(`Kid${REPORT_PAGE_SIZE}`)).toBeInTheDocument();
    expect(queryByText('Kid0')).not.toBeInTheDocument();

    fireEvent.click(getByText('◀ Anterior'));
    expect(getByText('Página 1 de 2')).toBeInTheDocument();
    expect(getByText('Kid0')).toBeInTheDocument();
  });

  it('shows the empty state and no pager when there are no chat lines', () => {
    const { getByText, queryByText } = render(<LobbyReports report={chatReport([])} close={noop} />);
    expect(getByText('Nada por aqui ainda.')).toBeInTheDocument();
    expect(queryByText(/Página/)).not.toBeInTheDocument();
  });

  it('closes when the close button is clicked', () => {
    const close = vi.fn();
    const { getByText } = render(<LobbyReports report={chatReport([])} close={close} />);
    fireEvent.click(getByText('Fechar'));
    expect(close).toHaveBeenCalledOnce();
  });
});
