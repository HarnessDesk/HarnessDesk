/**
 * The steps of a run: what each prints, what a failure does, and what a step
 * that reads another step's output does when that one failed.
 *
 * A failure does not stop the run, which is right for checks that stand on
 * their own: a failing test and a failing token snapshot are independent
 * findings, and seeing both in one run is worth the wait. It is wrong twice
 * over. For a step that invalidates every step after it — running twelve more
 * checks against a tree the lockfile cannot produce spends several minutes to
 * bury the one line that matters — which is what `stop` is for. And for a step
 * that reads what another step built: `pnpm verify` ran the node tests over
 * whatever `dist` a failed build had left behind and printed `ok` beside them,
 * so the run was red for the build while the tests' own line said they passed
 * (#208). A step that `needs` another is not run when that one did not pass,
 * and says which.
 *
 * Everything a run writes goes through `out` and `err`, and `exit` ends it, so
 * a test can hold all three.
 */
export const createSteps = ({ out = process.stdout, err = process.stderr, exit = (code) => process.exit(code) } = {}) => {
  const failures = []
  const skipped = []
  const passed = new Set()

  const report = () => {
    err.write('\n')
    for (const { name, error } of failures) {
      err.write(`--- ${name} ---\n`)
      const detail = error.stdout?.toString() || error.stderr?.toString() || error.message
      err.write(`${detail}\n`)
    }
    for (const { name, needs } of skipped) {
      err.write(`--- ${name} ---\nnot run: ${needs} failed, and this reads what it builds.\n`)
    }
  }

  /** One step: true when it ran and passed. `stop` ends the run here; `needs` names a step this one reads. */
  const step = (name, fn, { stop = false, needs = null } = {}) => {
    if (needs !== null && !passed.has(needs)) {
      skipped.push({ name, needs })
      out.write(`• ${name} ... not run: ${needs} failed\n`)
      return false
    }
    out.write(`• ${name} ... `)
    try {
      fn()
      out.write('ok\n')
      passed.add(name)
      return true
    } catch (error) {
      out.write('FAILED\n')
      failures.push({ name, error })
      if (stop) {
        report()
        exit(1)
      }
      return false
    }
  }

  return { step, report, failures, skipped, passed }
}
