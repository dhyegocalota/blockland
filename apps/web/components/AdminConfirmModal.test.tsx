// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminConfirmModal from './AdminConfirmModal';

afterEach(cleanup);

function setup(open: boolean, busy = false) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <AdminConfirmModal open={open} title="Delete tenant" message="Delete acme?" confirmLabel="Delete"
      busy={busy} onConfirm={onConfirm} onCancel={onCancel} />,
  );
  return { onConfirm, onCancel };
}

describe('AdminConfirmModal', () => {
  it('renders nothing while closed', () => {
    setup(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirms and cancels through the buttons', () => {
    const { onConfirm, onCancel } = setup(true);
    fireEvent.click(screen.getByText('Delete'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Cancelar'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape', () => {
    const { onCancel } = setup(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables both actions while busy', () => {
    setup(true, true);
    expect(screen.getByText('Aguarde...')).toBeDisabled();
    expect(screen.getByText('Cancelar')).toBeDisabled();
  });
});
