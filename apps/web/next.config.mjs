import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  env: {
    // Build identifier surfaced in the in-game debug panel: Vercel's short commit SHA, or "dev" locally.
    NEXT_PUBLIC_APP_VERSION: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
  },
};

// Wraps the build so Sentry can instrument the server + tunnel browser events. Source-map upload is
// skipped unless SENTRY_AUTH_TOKEN is set; runtime error reporting only needs NEXT_PUBLIC_SENTRY_DSN.
export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  disableLogger: true,
});
