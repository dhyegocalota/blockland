import * as Sentry from '@sentry/nextjs';

// Error reporting for the Edge runtime (middleware / edge routes). No-op when DSN is unset.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: true,
  tracesSampleRate: 0,
});
