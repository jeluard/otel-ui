import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4000',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // Serves the pre-built dist/ via Python's built-in HTTP server.
  // Run `make build-frontend` (or `npm run build`) before running tests.
  webServer: {
    command: 'python3 -m http.server 4000 --directory dist',
    url: 'http://localhost:4000',
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
