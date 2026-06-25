'use client';

// In-UI toast system for /admin: replaces the old single setMsg() string and any native alert().
// A provider holds a small queue; useAdminToast() pushes success/error/info toasts that auto-dismiss.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export enum ToastKind {
  Success = 'success',
  Error = 'error',
  Info = 'info',
}

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  show(params: { kind: ToastKind; message: string }): void;
}

const AUTO_DISMISS_MS = 4000;
const ToastContext = createContext<ToastApi | null>(null);

export function useAdminToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useAdminToast must be used inside AdminToastProvider');
  return api;
}

export function AdminToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback<ToastApi['show']>(({ kind, message }) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, kind, message }]);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="adminToasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <AdminToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function AdminToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <button className={`adminToast ${toast.kind}`} onClick={() => onDismiss(toast.id)} type="button">
      {toast.message}
    </button>
  );
}
