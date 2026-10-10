import { createHash } from 'node:crypto'
import os from 'node:os'
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

/**
 * How many browsers run at once. One anywhere but CI: a Mac that other work
 * shares should not have several started on it, and a re-record of a baseline
 * (`UPDATE_METRICS`, `UPDATE_ALIGNMENT`) must stay a run of one file at a time.
 * On CI, half the cores, which is Playwright's own default: each browser draws
 * on a core of its own and the dev server needs one more. Three on a
 * four-core runner was tried first, and two of six shards then ran their tests
 * twice as slowly as the other four, with a test timing out in each of two.
 *
 * `PLAYWRIGHT_UI_SYSTEM_WORKERS` overrides it except while recording a baseline.
 */
const envWorkers = Number(process.env.PLAYWRIGHT_UI_SYSTEM_WORKERS)
const workers =
  process.env.UPDATE_METRICS === '1' || process.env.UPDATE_ALIGNMENT === '1'
    ? 1
    : Number.isInteger(envWorkers) && envWorkers > 0
      ? envWorkers
      : process.env.CI
        ? Math.max(1, Math.floor(os.availableParallelism() / 2))
        : 1

export default defineConfig({
  testDir: './e2e/ui-system',
  outputDir: './output/playwright/ui-system/results',
  // The frame wall's approved frames (frame-wall.spec.ts): local only, under
  // output/, never committed.
  snapshotPathTemplate: './output/playwright/ui-system/approved/{arg}{ext}',
  // Every test starts from its own page, and none reads what another left
  // behind, so with several workers they are dealt out one by one rather than
  // a file at a time: a file of sixty tests then keeps all of them busy
  // instead of holding one.
  fullyParallel: workers > 1,
  workers,
  retries: 0,
  // The defaults (30s a test, 5s an assertion) are sized for a browser that has
  // the machine to itself. Beside another, and the dev server, a test that takes
  // twenty seconds alone takes longer; the limit is for a test that is stuck,
  // not for one that is slow because its neighbour is busy.
  ...(workers > 1 ? { timeout: 90_000, expect: { timeout: 10_000 } } : {}),
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
