import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './shared';

/**
 * Browser E2E tests against the real server + built SPA on one origin.
 * Run: `npm run test:e2e` (builds first). Browsers: `npx playwright install chromium` once.
 * PW_CHROMIUM_PATH / PW_CHROMIUM_ARGS point at a different Chromium build when needed.
 */
const executablePath = process.env.PW_CHROMIUM_PATH;
const extraArgs = process.env.PW_CHROMIUM_ARGS?.split(' ').filter(Boolean) ?? [];

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: extraArgs,
    },
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], channel: undefined },
      testIgnore: /responsive\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], channel: undefined },
      testMatch: /responsive\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'npx tsx e2e/start-server.ts',
    cwd: '..',
    url: `${BASE_URL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
