import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  env: {
    // Build identifier surfaced in the in-game debug panel: Vercel's short commit SHA, or "dev" locally.
    NEXT_PUBLIC_APP_VERSION: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
  },
  // The offline-via-core path loads the wasm-bindgen `--target web` module in `lib/wasm/` (gitignored,
  // built by `npm run build:wasm`). Webpack needs `asyncWebAssembly` to bundle the `.wasm` the generated
  // glue fetches via `new URL('…_bg.wasm', import.meta.url)`; `topLevelAwait` lets that glue init cleanly.
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true, topLevelAwait: true };
    return config;
  },
};

// Wraps the build so Sentry can instrument the server + tunnel browser events. Source-map upload is
// skipped unless SENTRY_AUTH_TOKEN is set; runtime error reporting only needs NEXT_PUBLIC_SENTRY_DSN.
export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  disableLogger: true,
});
