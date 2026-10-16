import type { BoardEvidence, FlowExecution, GoalView } from '@harnessdesk/protocol'
import { runTimeline } from './run-timeline'

export type WrapDraft = {
  readonly summary: string
  readonly cards: ReadonlyMap<number, { readonly resolution: 'finished' | 'dropped' | null; readonly reason: string }>
}

/** The same observed picks the Run shows seed an editable receipt, never a guessed merge. */
export const wrapDraft = (view: GoalView, execution: FlowExecution | null, evidence: BoardEvidence | undefined): WrapDraft & { readonly notKept: ReadonlySet<number> } => {
  const rows = execution ? runTimeline({ execution, cards: view.board.intents, evidence }).rows : []
  const attempts = rows.filter(row => row.kind === 'card' && row.attempt !== null)
  const merged = new Set(rows.filter(row => row.kind === 'person' && row.status === 'Merged')
    .flatMap(row => row.pick?.attempts.filter(attempt => attempt.keep === 'kept').map(attempt => attempt.card) ?? []))
  const notKept = new Set(attempts.flatMap(row => row.keep === 'not-kept' && row.card !== null ? [row.card] : []))
  const cards = new Map(view.board.intents.map(intent => [intent.id, {
    resolution: notKept.has(intent.id) || intent.state === 'abandoned' ? 'dropped' as const : intent.state === 'done' ? 'finished' as const : null,
    reason: notKept.has(intent.id) ? 'Not kept after comparing the attempts.' : intent.state === 'abandoned' ? intent.note ?? '' : '',
  }]))
  const summary = !execution ? '' : (attempts.length ? attempts : rows.filter(row => row.card !== null && row.kind !== 'attempt' && row.kind !== 'findings'))
    .map(row => {
      const intent = view.board.intents.find(intent => intent.id === row.card)
      if (!intent) return null
      const outcome = merged.has(intent.id) ? 'Merged' : notKept.has(intent.id) ? 'Not kept' : row.keep === 'kept' ? 'Kept' : row.status
      return outcome ? `#${intent.id} · ${intent.title} — ${outcome}` : null
    }).filter(Boolean).join('\n')
  return { summary, cards, notKept }
}
