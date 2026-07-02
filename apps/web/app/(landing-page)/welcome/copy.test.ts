import { describe, expect, it } from 'vitest';
import { COPY, DEMO_URL, demoUrl, isEmailValid } from './copy';

describe('demoUrl', () => {
  it('carries the current locale in the demo URL so it opens in the same language', () => {
    expect(demoUrl('pt-BR')).toBe(`${DEMO_URL}/pt-br`);
    expect(demoUrl('en-US')).toBe(`${DEMO_URL}/en-us`);
  });
});

describe('isEmailValid', () => {
  it('rejects empty and malformed addresses that should keep the submit button disabled', () => {
    expect(isEmailValid('')).toBe(false);
    expect(isEmailValid('   ')).toBe(false);
    expect(isEmailValid('parent')).toBe(false);
    expect(isEmailValid('parent@')).toBe(false);
    expect(isEmailValid('parent@email')).toBe(false);
    expect(isEmailValid('parent email@x.com')).toBe(false);
  });

  it('accepts a well-formed address, trimming surrounding spaces', () => {
    expect(isEmailValid('parent@email.com')).toBe(true);
    expect(isEmailValid('  parent@email.com  ')).toBe(true);
  });
});

describe('COPY parent-inclusive and offer changes', () => {
  it('uses gender-neutral "membro fundador" in pt-BR and never the old gendered wording', () => {
    const ptText = JSON.stringify(COPY['pt-BR']);
    expect(ptText).not.toContain('de fundadora');
    expect(ptText).not.toContain('condição de fundadora');
    expect(COPY['pt-BR'].formTitle).toContain('membro fundador');
    expect(COPY['pt-BR'].success).toContain('membro fundador');
  });

  it('renames the submit labels and keeps a submitting label', () => {
    expect(COPY['pt-BR'].submit).toBe('Entrar na lista');
    expect(COPY['pt-BR'].submitting).toBe('Entrando…');
    expect(COPY['en-US'].submit).toBe('Join the list');
    expect(COPY['en-US'].submitting).toBe('Joining…');
  });

  it('addresses parents, not only moms', () => {
    expect(COPY['pt-BR'].faqTitle).toBe('Perguntas dos pais');
    expect(COPY['en-US'].faqTitle).toBe('Parents ask');
  });

  it('exposes a demo call to action in both locales', () => {
    expect(COPY['pt-BR'].demoCta).toContain('demo');
    expect(COPY['en-US'].demoCta).toContain('demo');
  });

  it('makes the 10-player limit explicit in the value stack', () => {
    expect(COPY['pt-BR'].valueStack.some((benefit) => benefit.text.includes('10'))).toBe(true);
    expect(COPY['en-US'].valueStack.some((benefit) => benefit.text.includes('10'))).toBe(true);
  });
});
