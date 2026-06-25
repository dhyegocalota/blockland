'use client';

// A labeled text input with real-time, inline validation. The validator returns an i18n message KEY
// (or null when valid); the field shows the rule hint, turns the message red once the user has typed,
// and reports its current error up so the parent can disable submit until every field is valid.
import { useEffect, type ChangeEvent } from 'react';
import { t } from '../lib/i18n';

interface AdminFieldParams {
  label: string;
  value: string;
  rule: string;
  validate: (value: string) => string | null;
  onChange: (value: string) => void;
  onValidity: (error: string | null) => void;
  type?: string;
  placeholder?: string;
}

export default function AdminField({
  label,
  value,
  rule,
  validate,
  onChange,
  onValidity,
  type = 'text',
  placeholder,
}: AdminFieldParams) {
  const error = validate(value);
  const touched = value !== '';

  useEffect(() => { onValidity(error); }, [error, onValidity]);

  return (
    <label className="adminField">
      <span className="adminFieldLabel">{label}</span>
      <input
        className={touched && error ? 'adminInput invalid' : 'adminInput'}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
      {touched && error ? (
        <span className="adminFieldError">{t(error)}</span>
      ) : (
        <span className="adminFieldRule">{rule}</span>
      )}
    </label>
  );
}
