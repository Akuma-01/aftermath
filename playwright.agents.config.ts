import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base,
  testDir: './tests/e2e-agents',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5175' },
  webServer: {
    command: 'tsx scripts/test-web-server.ts --scripted-agents',
    url: 'http://127.0.0.1:5175/api/health',
    reuseExistingServer: false,
    timeout: 60000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15000 },
  },
});
