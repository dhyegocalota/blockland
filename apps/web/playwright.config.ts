import { defineConfig, devices } from '@playwright/test';

// E2E for the coop reconnect experience. The spec opens TWO browser contexts (two players) against a
// real stack — the authoritative Rust server (apps/server) plus this Next app pointed at it via
// NEXT_PUBLIC_SERVER_URL. Booting that stack is documented in e2e/README.md; this config only assumes
// the web app is reachable at BASE_URL (default http://localhost:3000) with the server URL already set.
//
// Run with: npm run e2e   (after the server + `next dev` are up — see e2e/README.md)
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  // The reconnect grace is 8s server-side; allow comfortably more so the drop/resume window is observed.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
