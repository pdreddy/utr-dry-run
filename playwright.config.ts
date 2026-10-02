import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' }
});
