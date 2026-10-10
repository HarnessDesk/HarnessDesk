import type { RunTimelineInput } from './run-timeline'
import { sanitizeText } from './sanitize'
export const teamRunFacts = (input: RunTimelineInput) => {
  const execution = input.execution
  const budget = execution.findings?.budget
  const extra = execution.findings?.extraRound
  const limit = budget ? Math.max(budget.rounds, extra ? extra.after + (extra.count ?? 1) : 0) : null
  const closed = execution.findings?.closedRounds.length ?? execution.rounds.filter(one => one.state === 'closed').length
  const ids = new Set(execution.rounds.flatMap(one => one.cards))
  const facts = (input.evidence?.cards ?? []).filter(one => ids.has(one.card)).flatMap(one => one.facts)
    .filter(one => !one.record.restored).sort((a, b) => b.record.observedAt - a.record.observedAt)
  const observation = facts.find(one => one.record.fact.kind === 'pr')
  const pr = observation?.record.fact.kind === 'pr' ? observation.record.fact : null
  const ci = facts.find(one => one.record.fact.kind === 'ci' && one.record.fact.at === pr?.head && one.freshness.state === 'fresh')?.record.fact
  const diff = facts.find(one => one.record.fact.kind === 'diff' && one.record.fact.to === pr?.head && !one.record.fact.dirty && one.freshness.state === 'fresh')?.record.fact
  return {
    checks: ci?.kind === 'ci' ? ci.checks : null, changes: diff?.kind === 'diff' ? {added:diff.added,removed:diff.removed} : null,
    flow: sanitizeText(execution.document.flow.name), revision: execution.revision,
    budget: budget ? `${closed} of ${limit} rounds` : 'Not recorded',
    idle: budget ? `${execution.findings?.idleRounds ?? 0} of ${budget.withoutProgress} rounds` : 'Not recorded',
    origin: sanitizeText(input.origin ?? 'Not recorded'),
    branch: observation?.record.checkout?.branch ?? null,
    pr, stale: observation !== undefined && observation.freshness.state !== 'fresh',
    extra: extra ? `Authorized after round ${extra.after}: ${extra.count ?? 1} more rounds. ${extra.reason}` : null,
  }
}
