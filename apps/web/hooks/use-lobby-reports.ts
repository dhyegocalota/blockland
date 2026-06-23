'use client';

// The two lobby-admin reports (hours played + chat log). Opening one POSTs the admin's claim to the
// matching proxy, which proves tenant-admin authority server-side and returns the rows. Only one
// report is open at a time; closing clears it. Gated by the same session the lobby admin uses.
import { useCallback, useState } from 'react';
import { loadSession } from '../lib/session';
import type { ChatEntry, PlaytimeEntry } from '../lib/api';
import { debug } from '../lib/log';

export type ReportKind = 'playtime' | 'chat';

// The chat report lives at /api/admin/chatlog (not /chat); map each kind to its route segment so the
// fetch path matches the handler folder. A wrong segment is a 404 the browser can't recover from.
const REPORT_ROUTE: Record<ReportKind, string> = { playtime: 'playtime', chat: 'chatlog' };

interface ReportState {
  kind: ReportKind;
  loading: boolean;
  failed: boolean;
  playtime: PlaytimeEntry[];
  chat: ChatEntry[];
}

async function fetchReport(kind: ReportKind, tenant: string, claim: string): Promise<unknown[]> {
  const res = await fetch(`/api/admin/${REPORT_ROUTE[kind]}/${encodeURIComponent(tenant)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claim }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`report ${kind} failed (${res.status})`);
  return (await res.json()) as unknown[];
}

export function useLobbyReports() {
  const [report, setReport] = useState<ReportState | null>(null);

  const open = useCallback((kind: ReportKind) => {
    const session = loadSession();
    if (!session) return;
    setReport({ kind, loading: true, failed: false, playtime: [], chat: [] });
    fetchReport(kind, session.tenant, session.claim)
      .then((rows) => {
        if (kind === 'playtime') {
          setReport({ kind, loading: false, failed: false, playtime: rows as PlaytimeEntry[], chat: [] });
          return;
        }
        setReport({ kind, loading: false, failed: false, playtime: [], chat: rows as ChatEntry[] });
      })
      .catch((error) => {
        debug('lobby-admin', 'report failed', { kind, error: String(error) });
        setReport({ kind, loading: false, failed: true, playtime: [], chat: [] });
      });
  }, []);

  const close = useCallback(() => setReport(null), []);

  return { report, open, close };
}
