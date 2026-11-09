import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const e2eDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.join(e2eDir, 'tests'),
  outputDir: path.join(e2eDir, 'test-results'),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: path.join(e2eDir, 'playwright-report'), open: 'never' }]]
    : [['html', { outputFolder: path.join(e2eDir, 'playwright-report') }]],
  timeout: 30000,

  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Allow pointing at a preinstalled Chromium (e.g. in CI/sandbox
        // images where the bundled download is skipped) — mirrors the same
        // escape hatch in web-test-runner.config.mjs.
        ...(process.env.PW_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
          : {}),
      },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
