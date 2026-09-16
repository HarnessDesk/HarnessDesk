import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e/ui-system',
  outputDir: './output/playwright/ui-system/results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: './output/playwright/ui-system/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5274',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @harnessdesk/ui exec vite --host 127.0.0.1 --port 5274',
    url: 'http://127.0.0.1:5274/design.html?view=propagation',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
