// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminField from './AdminField';

afterEach(cleanup);

const validate = (value: string) => (value.length < 2 ? 'admin.invalid_id' : null);

describe('AdminField', () => {
  it('shows the rule while pristine and the error once typed invalid, reporting validity up', () => {
    const onValidity = vi.fn();
    const { rerender } = render(
      <AdminField label="ID" rule="2 to 32 chars" value="" validate={validate}
        onChange={() => {}} onValidity={onValidity} />,
    );
    expect(screen.getByText('2 to 32 chars')).toBeInTheDocument();
    expect(onValidity).toHaveBeenLastCalledWith('admin.invalid_id');

    rerender(
      <AdminField label="ID" rule="2 to 32 chars" value="a" validate={validate}
        onChange={() => {}} onValidity={onValidity} />,
    );
    expect(screen.queryByText('2 to 32 chars')).toBeNull();
    expect(screen.getByText('ID inválido: use a-z, 0-9 e hífen (2 a 32).')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveClass('invalid');
  });

  it('emits typed values through onChange', () => {
    const onChange = vi.fn();
    render(
      <AdminField label="ID" rule="rule" value="" validate={validate}
        onChange={onChange} onValidity={() => {}} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'acme' } });
    expect(onChange).toHaveBeenCalledWith('acme');
  });
});
