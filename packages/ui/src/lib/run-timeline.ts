export { runTimeline, runCardTiming, currentRunEnd, attemptWords, stepWords, type RunAttempt, type RunChange, type RunHeader, type RunPick, type RunTimelineInput, type RunTimelineRow } from '@harnessdesk/client/views'

import type { BoardEvidence, FlowExecution } from '@harnessdesk/protocol'

/** A Run's PR comes only from cards it opened; a Team without a Run reads its whole board. */
export const runPullRequest = (execution: FlowExecution | null, evidence: BoardEvidence | null | undefined): { number: number; url: string } | null => {
  const ids = execution ? new Set(execution.rounds.flatMap(round => round.cards)) : null
  const fact = evidence?.cards.filter(card => ids === null || ids.has(card.card)).flatMap(card => card.facts)
    .filter(view => !view.record.restored && view.record.fact.kind === 'pr')
    .sort((a, b) => b.record.observedAt - a.record.observedAt)[0]?.record.fact
  return fact?.kind === 'pr' && fact.url ? { number: fact.number, url: fact.url } : null
}
