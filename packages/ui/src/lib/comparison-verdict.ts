import { flowStepOf, type FlowExecution, type FlowStep, type Intent } from '@harnessdesk/protocol'
import type { RunAttempt, RunTimelineRow, runTimeline } from './run-timeline'

export type ComparisonVerdictModel = {
  kind: 'picked'
  id: string
  judge: RunTimelineRow
  attempt: RunAttempt
  reason: string | null
  next: RunTimelineRow | null
  keeps: ReadonlyMap<number, 'kept' | 'not-kept'>
} | {
  kind: 'waiting'
  id: string
  card: Intent
  step: FlowStep
}

/** Presentation of the Run's recorded selection, never another way to decide which attempt won. */
export const comparisonVerdictOf = (model: ReturnType<typeof runTimeline>, execution: FlowExecution, cards: readonly Intent[]): ComparisonVerdictModel | null => {
  const attempts = model.rows.filter(one => one.attempt !== null)
  const latestRound = Math.max(...attempts.map(one => one.round ?? -1))
  const current = attempts.filter(one => one.round === latestRound)
  if (current.length < 2) return null
  for (const judge of [...model.rows].reverse()) {
    if ((judge.round ?? -1) <= latestRound) continue
    if (judge.pick && judge.pick.attempts.some(one => current.some(row => row.card === one.card))) {
      const attempt = judge.pick.attempts.find(one => one.keep === 'kept')
      if (!attempt) return null
      // A person's timeline summary describes the step, not why they chose it.
      const card = cards.find(one => one.id === judge.card)
      const words = judge.kind === 'person' ? card?.note?.trim() || card?.handoff?.trim() || null : judge.summary
      const sentences = words ? new Intl.Segmenter('en', { granularity: 'sentence' }).segment(words) : []
      const reason = words && [...sentences].length === 1 ? words : null
      return { kind: 'picked', id: JSON.stringify([execution.id, judge.id, judge.pick.revision, judge.pick.attempts.map(one => [one.card, one.keep])]), judge, attempt, reason,
        next: model.rows.find(one => one.kind === 'person' && one.attention && (one.round ?? -1) > (judge.round ?? -1)) ?? null,
        keeps: new Map(judge.pick.attempts.flatMap(one => one.keep ? [[one.card, one.keep] as const] : [])),
      }
    }
    if (judge.kind === 'person' && judge.attention && judge.card !== null) {
      const card = cards.find(one => one.id === judge.card)
      const step = card ? flowStepOf(card, undefined, [execution]) : null
      if (card && step?.review && step.outcomes.includes('picked')) return { kind: 'waiting', id: `${execution.id}:${judge.id}:waiting`, card, step }
    }
  }
  return null
}
