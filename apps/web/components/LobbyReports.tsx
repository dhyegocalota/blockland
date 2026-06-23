'use client';

// The open lobby-admin report (hours played or chat log), rendered as a kid-friendly overlay modal
// that reuses the connecting/update overlay panel and the admin roster list styles (#adminReports
// list/li/playerName). The data + open/close live in useLobbyReports; this pages the (bounded) rows
// client-side with paginate() and runs the formatters to turn raw ms/timestamps into localized labels.
import { useState } from 'react';
import { t } from '../lib/i18n';
import { formatPlaytime, paginate, relativeTime } from '../lib/report-format';
import type { ReportKind } from '../hooks/use-lobby-reports';
import type { ChatEntry, PlaytimeEntry } from '../lib/api';

interface ReportView {
  kind: ReportKind;
  loading: boolean;
  failed: boolean;
  playtime: PlaytimeEntry[];
  chat: ChatEntry[];
}

function PlaytimeRows({ rows }: { rows: PlaytimeEntry[] }) {
  return (
    <ul id="adminReports">
      {rows.map((entry) => {
        const played = formatPlaytime(entry.used_ms);
        return (
          <li key={entry.key}>
            <span className="playerName">{entry.key}</span>
            <span className="reportBy">{t(played.key, played.vars)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ChatRows({ rows, now }: { rows: ChatEntry[]; now: number }) {
  return (
    <ul id="adminReports">
      {rows.map((entry, index) => {
        const when = relativeTime(entry.sent_at, now);
        return (
          <li key={`${entry.sent_at}-${index}`}>
            <span className="playerName">{entry.name}</span>
            <span className="reportBy">{entry.text}</span>
            <span className="reportBy">{t(when.key, when.vars)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function LobbyReports({ report, close }: { report: ReportView; close: () => void }) {
  const [requestedPage, setRequestedPage] = useState(1);
  const titleKey = report.kind === 'playtime' ? 'report.playtime_title' : 'report.chat_title';
  const rows = report.kind === 'playtime' ? report.playtime : report.chat;
  const ready = !report.loading && !report.failed;
  const playtimePage = paginate(report.playtime, requestedPage);
  const chatPage = paginate(report.chat, requestedPage);
  const page = report.kind === 'playtime' ? playtimePage : chatPage;
  const showPager = ready && rows.length > 0;

  return (
    <div id="reportOverlay" role="dialog" aria-modal="true" onClick={close}>
      <div className="panel" onClick={(event) => event.stopPropagation()}>
        <h2>{t(titleKey)}</h2>
        <span className="reportWindow">{t('report.window')}</span>
        {report.loading && <span className="reportBy">{t('report.loading')}</span>}
        {report.failed && <span className="reportBy">{t('report.failed')}</span>}
        {ready && rows.length === 0 && <span className="reportBy">{t('report.empty')}</span>}
        {ready && report.kind === 'playtime' && <PlaytimeRows rows={playtimePage.items} />}
        {ready && report.kind === 'chat' && <ChatRows rows={chatPage.items} now={Date.now()} />}
        {showPager && (
          <div className="reportPager">
            <button
              className="reportPage"
              disabled={page.page <= 1}
              onClick={() => setRequestedPage((current) => current - 1)}
            >
              {t('report.prev')}
            </button>
            <span className="reportPageOf">{t('report.page_of', { page: page.page, total: page.totalPages })}</span>
            <button
              className="reportPage"
              disabled={page.page >= page.totalPages}
              onClick={() => setRequestedPage((current) => current + 1)}
            >
              {t('report.next')}
            </button>
          </div>
        )}
        <button id="adminReportClose" onClick={close}>
          {t('report.close')}
        </button>
      </div>
    </div>
  );
}
