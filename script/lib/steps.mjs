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
  const declared = new Set()

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
    /* A `needs` naming no step is a typo, and the run would swallow it: the
       dependent step is skipped and the report reads `not run: biuld failed`,
       naming a step that does not exist. That is an error in the roster rather
       than a finding about the tree, so it stops the run where it is written,
       and it is checked against the steps *declared before this one* — which
       is the only kind a step can read the output of (#263). */
    if (needs !== null && !declared.has(needs)) {
      throw new Error(`step "${name}" needs "${needs}", which no step before it declares.`)
    }
    declared.add(name)
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
