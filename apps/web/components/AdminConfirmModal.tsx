'use client';

// In-UI confirm dialog for /admin: replaces native confirm() (e.g. tenant delete). Renders nothing
// when closed; on Esc or backdrop click it cancels, mirroring the game's modal close behavior.
import { useEffect } from 'react';
import { t } from '../lib/i18n';

interface AdminConfirmModalParams {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function AdminConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: AdminConfirmModalParams) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="adminModalBackdrop" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="adminModalCard" onClick={(event) => event.stopPropagation()}>
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="adminModalActions">
          <button className="adminBtnGhost" type="button" onClick={onCancel} disabled={busy}>
            {t('admin.cancel')}
          </button>
          <button className="adminBtnDanger" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? t('admin.working') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
