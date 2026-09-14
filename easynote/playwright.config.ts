import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/ui.spec.ts',
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:8792',
    viewport: { width: 1440, height: 960 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --import tsx test/server.ts',
    url: 'http://127.0.0.1:8792/api/session',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
