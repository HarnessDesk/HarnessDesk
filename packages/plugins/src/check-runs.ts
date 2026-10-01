interface CheckRun {
  readonly name: string
  readonly id: number | string
  readonly started_at: string | null
  readonly status: string
  readonly conclusion: string | null
}

export interface CheckRunsAssessment {
  readonly green: boolean
  readonly reason: string
}

const newestFirst = (a: CheckRun, b: CheckRun): number => {
  const time = String(b.started_at ?? '').localeCompare(String(a.started_at ?? ''))
  if (time !== 0) return time
  return Number(b.id ?? 0) - Number(a.id ?? 0)
}

const greenConclusions = new Set(['success', 'skipped', 'neutral'])

const stateOf = (run: CheckRun): string => {
  if (run.status !== 'completed') return `is ${run.status.replaceAll('_', ' ') || 'in an unknown state'}`
  if (run.conclusion === 'failure') return 'failed'
  return `has conclusion ${run.conclusion?.replaceAll('_', ' ') || 'none'}`
}

/** Checks every check name on a commit, considering only its newest run. */
export const assessCheckRuns = (runs: readonly CheckRun[]): CheckRunsAssessment => {
  if (runs.length === 0) return { green: false, reason: 'no CI has reported on this commit.' }

  const newest = new Map<string, CheckRun>()
  for (const run of runs) {
    const current = newest.get(run.name)
    if (!current || newestFirst(run, current) < 0) newest.set(run.name, run)
  }

  const offending = [...newest.values()].filter(
    (run) => run.status !== 'completed' || !greenConclusions.has(run.conclusion ?? ''),
  )
  if (offending.length === 0) return { green: true, reason: '' }

  const shown = offending.slice(0, 5).map((run) => `“${run.name}” ${stateOf(run)}`)
  const more = offending.length > shown.length ? `; and ${offending.length - shown.length} more` : ''
  return { green: false, reason: `${shown.join('; ')}${more}.` }
}
