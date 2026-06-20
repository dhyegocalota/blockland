import * as Sentry from '@sentry/nextjs';

// Next.js server-side error reporting. DSN comes from env, so it's a no-op when unset (local/CI).
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: true,
  tracesSampleRate: 0,
});
