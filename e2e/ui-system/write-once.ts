import type { test as base } from '@playwright/test'

/**
 * Run `write` once, after the last test in the calling file, and only if
 * every test in it ended as expected.
 *
 * Called at the top of a spec, it runs the file serially: every test in one
 * worker, so the flag below sees all of them, and the first failure skips
 * the rest. The write comes from `afterAll`, which the runner calls after
 * every test's own fixtures are torn down — its pages closed among them — so
 * nothing in the file is still open when the write lands. A failure anywhere
 * leaves the flag set and the write unmade, whatever order the tests are
 * declared in.
 *
 * `metrics.spec.ts` records its table this way. `write-once.spec.ts` holds
 * both promises — a failure writes nothing, and the one write comes after
 * the last page has closed — against the real runner.
 */
export const writeOnceEveryTestPasses = (test: typeof base, write: () => void) => {
  test.describe.configure({ mode: 'serial' })
  let failed = false
  test.afterEach(({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) failed = true
  })
  test.afterAll(() => {
    if (!failed) write()
  })
}
