import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for E2E tests.
 *
 * Targets the Chrome/Chromium engine on Linux (the GitHub Actions
 * environment). The suite runs against the production build served by
 * `vite preview`, which also sends the COOP/COEP headers required for the
 * SQLite OPFS backend.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:4199',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm exec vite preview --port 4199 --strictPort',
    url: 'http://localhost:4199',
    timeout: 120 * 1000,
    reuseExistingServer: !process.env.CI,
  },
});
