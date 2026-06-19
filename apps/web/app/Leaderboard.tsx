'use client';

// Compact, collapsible two-tab leaderboard for the start screen: "All time" and "Last 30 days".
// It is read-only and public, fetched from /api/leaderboard/:tenant (which is CDN + in-process
// cached). It briefly caches each tab client-side so flipping tabs is instant, and it never blocks
// the start screen — a fetch failure just shows a quiet message.
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import { debug, warn } from '../lib/log';
import type { ScoreEntry } from '../lib/api';

type BoardWindow = 'all' | 'month';
type Status = 'loading' | 'ready' | 'error';

const TOP_VISIBLE = 10;
const CLIENT_CACHE_MS = 60_000;

interface CacheRecord {
  scores: ScoreEntry[];
  at: number;
}

export default function Leaderboard({ tenant }: { tenant: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<BoardWindow>('all');
  const [scores, setScores] = useState<ScoreEntry[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const cache = useRef<Map<BoardWindow, CacheRecord>>(new Map());

  const load = useCallback(
    async (window: BoardWindow) => {
      const fresh = cache.current.get(window);
      if (fresh && Date.now() - fresh.at < CLIENT_CACHE_MS) {
        setScores(fresh.scores);
        setStatus('ready');
        return;
      }
      setStatus('loading');
      try {
        const query = window === 'month' ? '?window=month' : '';
        const res = await fetch(`/api/leaderboard/${encodeURIComponent(tenant)}${query}`);
        if (!res.ok) throw new Error(`leaderboard ${res.status}`);
        const data = ((await res.json()) as ScoreEntry[]).slice(0, TOP_VISIBLE);
        cache.current.set(window, { scores: data, at: Date.now() });
        setScores(data);
        setStatus('ready');
        debug('leaderboard', 'loaded', { tenant, window, count: data.length });
      } catch (error) {
        warn('leaderboard', 'load failed', { tenant, window, error: String(error) });
        setStatus('error');
      }
    },
    [tenant],
  );

  useEffect(() => {
    if (!open) return;
    load(tab);
  }, [open, tab, load]);

  if (!open) {
    return (
      <button id="boardToggle" className="ghost" onClick={() => setOpen(true)}>
        {t('board.show')}
      </button>
    );
  }

  return (
    <div id="leaderboard">
      <div className="boardHead">
        <span className="boardTitle">{t('board.title')}</span>
        <button className="boardClose" onClick={() => setOpen(false)} aria-label={t('board.hide')}>
          ✕
        </button>
      </div>
      <div className="boardTabs" role="tablist">
        <button
          className={tab === 'all' ? 'on' : undefined}
          role="tab"
          aria-selected={tab === 'all'}
          onClick={() => setTab('all')}
        >
          {t('board.tab_all')}
        </button>
        <button
          className={tab === 'month' ? 'on' : undefined}
          role="tab"
          aria-selected={tab === 'month'}
          onClick={() => setTab('month')}
        >
          {t('board.tab_month')}
        </button>
      </div>
      {status === 'loading' && <p className="boardMsg">{t('board.loading')}</p>}
      {status === 'error' && <p className="boardMsg">{t('board.error')}</p>}
      {status === 'ready' && scores.length === 0 && <p className="boardMsg">{t('board.empty')}</p>}
      {status === 'ready' && scores.length > 0 && (
        <ol className="boardList">
          {scores.map((entry, index) => (
            <li key={`${entry.name}-${index}`}>
              <span className="boardRank">{index + 1}</span>
              <span className="boardName">{entry.name}</span>
              <span className="boardScore">{entry.score}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
