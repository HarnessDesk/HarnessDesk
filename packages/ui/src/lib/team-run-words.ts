import type { RunTimelineRow } from './run-timeline'

/** Counts the attempt cards the Run actually opened, independent of routing rounds. */
export const comparisonProgress = (rows: readonly RunTimelineRow[] | undefined): string | null => {
  const attempts = rows?.filter(row => row.kind === 'card' && row.attempt !== null) ?? []
  if (!attempts.length) return null
  const picks = rows?.filter(row => row.pick?.attempts.some(attempt => attempt.keep === 'kept')) ?? []
  const latest = picks.at(-1)
  const who = picks.some(row => row.kind === 'card' && row.pick?.revision === latest?.pick?.revision) ? 'Referee' : 'You'
  return `${attempts.length} ${attempts.length === 1 ? 'attempt' : 'attempts'}${latest ? ` · ${who} picked` : ''}`
}
