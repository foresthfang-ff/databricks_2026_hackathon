import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || 4173}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : {
        command:
          'npm run build:client && node node_modules/vite/bin/vite.js preview --config client/vite.config.ts --host 127.0.0.1 --port 4173',
        url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || 4173}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
      },
});
