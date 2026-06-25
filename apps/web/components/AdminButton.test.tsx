// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminButton, { AdminButtonVariant } from './AdminButton';

afterEach(cleanup);

describe('AdminButton', () => {
  it('shows a spinner and stays disabled while busy', () => {
    const onClick = vi.fn();
    render(<AdminButton busy onClick={onClick}>Save</AdminButton>);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button.querySelector('.adminSpinner')).toBeInTheDocument();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('fires onClick when idle and maps the variant class', () => {
    const onClick = vi.fn();
    render(<AdminButton variant={AdminButtonVariant.Danger} onClick={onClick}>Delete</AdminButton>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('adminBtnDanger');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
