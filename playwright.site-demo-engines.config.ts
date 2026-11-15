import { createHash } from 'node:crypto'
import { defineConfig, devices } from '@playwright/test'

const port = 52000 + createHash('sha256').update(import.meta.url).digest().readUInt32BE(0) % 1000
const origin = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './e2e/site-demo-engines',
  workers: 1,
  retries: 0,
  outputDir: './output/playwright/site-demo-engines',
  reporter: 'list',
  use: { baseURL: origin, headless: true, viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', trace: 'retain-on-failure' },
  projects: [
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `pnpm --filter @harnessdesk/ui exec vite preview --config vite.site-demo.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin, reuseExistingServer: false, timeout: 120_000,
  },
})
