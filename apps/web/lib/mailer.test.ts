import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendEmail = vi.fn();
vi.mock('resend', () => ({ Resend: vi.fn(() => ({ emails: { send: sendEmail } })) }));
vi.mock('@react-email/render', () => ({ render: vi.fn(async () => '<html></html>') }));

import { send } from './mailer';
import { Resend } from 'resend';

const resendCtor = vi.mocked(Resend);

const params = {
  to: 'a@x.io',
  subject: '123456 is your login code',
  react: null as never,
  devMagicLink: 'http://x/claim?token=tok',
  devCode: '123456',
};

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
});

afterEach(() => vi.clearAllMocks());

describe('mailer', () => {
  it('logs to the console and never sends when RESEND_API_KEY is unset', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(send(params)).resolves.toBeUndefined();
    expect(resendCtor).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it('sends via Resend when configured', async () => {
    process.env.RESEND_API_KEY = 'key';
    process.env.MAIL_FROM = 'noreply@x.io';
    await send(params);
    expect(resendCtor).toHaveBeenCalledWith('key');
    expect(sendEmail).toHaveBeenCalledWith({
      from: 'noreply@x.io',
      to: 'a@x.io',
      subject: '123456 is your login code',
      html: '<html></html>',
    });
  });
});
