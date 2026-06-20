'use client';

// Magic-link landing page: a player tapped the "log in" button in their email, arriving here with a
// ?token. We verify it, store the resulting bl-session, then bounce back to the game.
import { useEffect, useState } from 'react';
import { saveSession } from '../../lib/session';
import { t } from '../../lib/i18n';

type Status = 'verifying' | 'ok' | 'failed';

export default function ClaimPage() {
  const [status, setStatus] = useState<Status>('verifying');

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setStatus('failed');
      return;
    }
    let alive = true;
    fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((res) => res.json())
      .then((data: { ok: boolean; tenant?: string; name?: string; claim?: string; is_admin?: boolean }) => {
        if (!alive) return;
        if (!data.ok || !data.tenant || !data.name || !data.claim) {
          setStatus('failed');
          return;
        }
        saveSession({ tenant: data.tenant, name: data.name, claim: data.claim, is_admin: data.is_admin === true });
        setStatus('ok');
        window.location.replace('/');
      })
      .catch(() => alive && setStatus('failed'));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div id="claimStatus" role="status">
      {status === 'verifying' && t('claim.verifying')}
      {status === 'ok' && t('claim.ok')}
      {status === 'failed' && t('claim.failed')}
    </div>
  );
}
