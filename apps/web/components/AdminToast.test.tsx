// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminToastProvider, ToastKind, useAdminToast } from './AdminToast';

afterEach(cleanup);

function Trigger({ kind, message }: { kind: ToastKind; message: string }) {
  const toast = useAdminToast();
  return <button onClick={() => toast.show({ kind, message })}>fire</button>;
}

describe('AdminToast', () => {
  it('shows a pushed toast with its kind class and auto-dismisses', () => {
    vi.useFakeTimers();
    try {
      render(
        <AdminToastProvider>
          <Trigger kind={ToastKind.Success} message="Saved!" />
        </AdminToastProvider>,
      );
      fireEvent.click(screen.getByText('fire'));
      const toast = screen.getByText('Saved!');
      expect(toast).toHaveClass('adminToast', 'success');
      act(() => { vi.advanceTimersByTime(4000); });
      expect(screen.queryByText('Saved!')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismisses on click before the timer fires', () => {
    render(
      <AdminToastProvider>
        <Trigger kind={ToastKind.Error} message="Boom" />
      </AdminToastProvider>,
    );
    fireEvent.click(screen.getByText('fire'));
    fireEvent.click(screen.getByText('Boom'));
    expect(screen.queryByText('Boom')).toBeNull();
  });
});
