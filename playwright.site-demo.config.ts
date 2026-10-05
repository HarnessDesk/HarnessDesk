import { createHash } from 'node:crypto'
import { defineConfig } from '@playwright/test'

const port = 5900 + createHash('sha256').update(import.meta.url).digest().readUInt32BE(0) % 100
export default defineConfig({
  testDir: './e2e/site-demo', workers: 1, retries: 0,
  outputDir: './output/playwright/site-demo', reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' },
  webServer: {
    command: `pnpm --filter @harnessdesk/ui exec vite preview --config vite.site-demo.config.ts --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120_000,
  },
})
