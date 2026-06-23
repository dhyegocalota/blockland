'use client';

// The open lobby-admin report (hours played or chat log), rendered as an on-theme list that reuses
// the admin roster styles (#adminReports list/li/playerName). Pure presentation: the data + open/close
// live in useLobbyReports; the formatters turn raw ms/timestamps into localized labels.
import { t } from '../lib/i18n';
import { formatPlaytime, relativeTime } from '../lib/report-format';
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
  const titleKey = report.kind === 'playtime' ? 'report.playtime_title' : 'report.chat_title';
  const rows = report.kind === 'playtime' ? report.playtime : report.chat;
  return (
    <>
      <span className="adminLabel">{t(titleKey)}</span>
      <span className="reportBy">{t('report.window')}</span>
      {report.loading && <span className="reportBy">{t('report.loading')}</span>}
      {report.failed && <span className="reportBy">{t('report.failed')}</span>}
      {!report.loading && !report.failed && rows.length === 0 && (
        <span className="reportBy">{t('report.empty')}</span>
      )}
      {!report.loading && !report.failed && report.kind === 'playtime' && (
        <PlaytimeRows rows={report.playtime} />
      )}
      {!report.loading && !report.failed && report.kind === 'chat' && (
        <ChatRows rows={report.chat} now={Date.now()} />
      )}
      <button id="adminReportClose" onClick={close}>
        {t('report.close')}
      </button>
    </>
  );
}
