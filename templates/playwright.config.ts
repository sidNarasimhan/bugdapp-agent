import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  timeout: 180_000,
  use: {
    trace: 'on-first-retry',
    screenshot: 'on',
    actionTimeout: 30_000,
  },
  projects: [
    {
      name: 'metamask',
      testMatch: '**/*.spec.ts',
    },
  ],
});
