import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

/**
 * `writeOnceEveryTestPasses`, run by the real runner.
 *
 * A spec is written here — three tests, each opening a page — and handed to
 * the Playwright CLI in a process of its own; what it leaves behind is read
 * back: an event log, and whether its "table" was written. Two things are
 * held: a failure leaves the table unwritten, and when every test passes it
 * is written once, after the last page has closed. A test of the helper
 * against a stand-in runner could only say what the helper does with the
 * calls it expects; this says which calls the pinned runner makes, and when.
 * A re-record of `metrics.json` is written through this helper, and review
 * of #788 asked for exactly those two things to be held by something
 * committed.
 */
const HELPER = fileURLToPath(new URL('./write-once', import.meta.url))
const CLI = createRequire(import.meta.url).resolve('@playwright/test/cli')

const FIXTURE = `
import { appendFileSync, writeFileSync } from 'node:fs'
import { test } from '@playwright/test'
import { writeOnceEveryTestPasses } from ${JSON.stringify(HELPER)}

const { EVENTS, TABLE, FAIL } = process.env as Record<string, string>
writeOnceEveryTestPasses(test, () => {
  appendFileSync(EVENTS, 'write\\n')
  writeFileSync(TABLE, 'the table\\n')
})
for (const name of ['one', 'two', 'three']) {
  test(name, async ({ page }) => {
    page.on('close', () => appendFileSync(EVENTS, \`closed \${name}\\n\`))
    await page.goto('about:blank')
    appendFileSync(EVENTS, \`ran \${name}\\n\`)
    if (name === FAIL) throw new Error('failed on purpose')
  })
}
`

/** Run the fixture spec in `dir`, failing the test named `fail`, and read back what it left. */
const run = (dir: string, fail = '') => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'fixture.spec.ts'), FIXTURE)
  writeFileSync(join(dir, 'playwright.config.ts'), "export default { testDir: '.', workers: 1, reporter: 'line', outputDir: 'results' }\n")
  const events = join(dir, 'events')
  const table = join(dir, 'table')
  const child = spawnSync(process.execPath, [CLI, 'test', '-c', join(dir, 'playwright.config.ts')], {
    cwd: dir,
    encoding: 'utf8',
    // Only what a runner needs to find its browser: nothing of this run's own worker.
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      TMPDIR: process.env['TMPDIR'],
      PLAYWRIGHT_BROWSERS_PATH: process.env['PLAYWRIGHT_BROWSERS_PATH'],
      EVENTS: events,
      TABLE: table,
      FAIL: fail,
    },
  })
  return {
    status: child.status,
    output: `${child.stdout}${child.stderr}`,
    events: existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n') : [],
    written: existsSync(table),
  }
}

test('a failure in the file leaves the table unwritten', async ({}, testInfo) => {
  const { status, output, events, written } = run(testInfo.outputPath('fixture'), 'two')
  expect(status, output).toBe(1)
  // `three` is skipped: serial mode stops at the failure, and `afterAll` still runs.
  expect(events, output).toEqual(['ran one', 'closed one', 'ran two', 'closed two'])
  expect(written, output).toBe(false)
})

test('when every test passes the table is written once, after the last page has closed', async ({}, testInfo) => {
  const { status, output, events, written } = run(testInfo.outputPath('fixture'))
  expect(status, output).toBe(0)
  expect(events, output).toEqual(['ran one', 'closed one', 'ran two', 'closed two', 'ran three', 'closed three', 'write'])
  expect(written, output).toBe(true)
})
