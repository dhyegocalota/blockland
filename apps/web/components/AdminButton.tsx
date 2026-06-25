'use client';

// A button that shows an inline spinner + disables itself while its action is in flight, so every
// /admin mutation reads as busy instead of silently hanging. Variants map to the admin button classes.
import type { ReactNode } from 'react';

export enum AdminButtonVariant {
  Primary = 'adminBtn',
  Ghost = 'adminBtnGhost',
  Danger = 'adminBtnDanger',
}

interface AdminButtonParams {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: AdminButtonVariant;
  busy?: boolean;
  disabled?: boolean;
}

export default function AdminButton({
  children,
  onClick,
  type = 'button',
  variant = AdminButtonVariant.Primary,
  busy = false,
  disabled = false,
}: AdminButtonParams) {
  return (
    <button className={variant} type={type} onClick={onClick} disabled={busy || disabled}>
      {busy && <span className="adminSpinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
