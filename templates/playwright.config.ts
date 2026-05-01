import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  // 5 min per test — MetaMask onboarding (~90s), wallet connect, RPC chain
  // switch, and 10-step trade flow + tx wait can together exceed 3 min.
  timeout: 300_000,
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
