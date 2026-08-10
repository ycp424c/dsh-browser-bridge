import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    headless: true,
    // Extensions require the full Chromium binary (the headless shell does
    // not support them); the new headless mode runs the full binary.
    channel: 'chromium',
  },
})
