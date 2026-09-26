import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

/**
 * The port this suite's dev server binds. `reuseExistingServer: false` means
 * a second checkout running this suite at the same time kills the first
 * run's server the moment its own `webServer` starts on the same port —
 * `ERR_CONNECTION_REFUSED` failures that have nothing to do with the change
 * under test (#995).
 *
 * `PLAYWRIGHT_UI_SYSTEM_PORT` overrides the port outright. Otherwise it is
 * derived from a hash of this file's own directory — the repository root —
 * so the same checkout always lands on the same port (stable across runs,
 * so a developer's muscle memory and any port-scoped tooling keep working)
 * while a different worktree's checkout, at a different path, very likely
 * lands on a different one. The range is picked clear of this repo's other
 * fixed dev ports (5273, 5274, 5599).
 */
const PORT_RANGE_BASE = 5600
const PORT_RANGE_SIZE = 200
const derivedPort = (seed: string): number =>
  PORT_RANGE_BASE + (createHash('sha256').update(seed).digest().readUInt32BE(0) % PORT_RANGE_SIZE)

const repoRoot = path.dirname(fileURLToPath(import.meta.url))
const envPort = Number(process.env.PLAYWRIGHT_UI_SYSTEM_PORT)
const port = Number.isInteger(envPort) && envPort > 0 ? envPort : derivedPort(repoRoot)
const origin = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './e2e/ui-system',
  outputDir: './output/playwright/ui-system/results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: './output/playwright/ui-system/report', open: 'never' }]],
  use: {
    baseURL: origin,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `pnpm --filter @harnessdesk/ui exec vite --host 127.0.0.1 --port ${port}`,
    url: `${origin}/design.html?view=propagation`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
