import { defineConfig } from '@playwright/test';

/**
 * Browser suite: real Chromium-family engine, real selection, real scrolling.
 * Uses the installed Microsoft Edge so no browser download is needed.
 */
export default defineConfig({
  testDir: './test/browser',
  testMatch: '*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    // Edge is installed here; CI sets PW_CHANNEL=chromium after a browser install.
    channel: process.env.PW_CHANNEL || 'msedge',
    viewport: { width: 1000, height: 760 },
    trace: 'off',
  },
});
