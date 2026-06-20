import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
};

// Wraps the build so Sentry can instrument the server + tunnel browser events. Source-map upload is
// skipped unless SENTRY_AUTH_TOKEN is set; runtime error reporting only needs NEXT_PUBLIC_SENTRY_DSN.
export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  disableLogger: true,
});
