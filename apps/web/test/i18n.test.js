import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../lib/i18n/index';
import { messages } from '../lib/i18n/catalog';

afterEach(() => {
  delete globalThis.window;
});

describe('t', () => {
  it('returns pt-BR by default (no window)', () => {
    expect(t('block.grass')).toBe(messages['pt-BR']['block.grass']);
  });

  it('interpolates {vars}', () => {
    expect(t('start.record_score', { score: 42 })).toBe('🏆 Recorde: 42');
  });

  it('falls back to the key when the message is missing', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
  });
});
