import type { BoardEvidence, Intent } from '@harnessdesk/protocol'

/** The card and named check the person is asked to run for the reviewed change. */
export interface LeadCheckAsk { readonly card: number; readonly name: string }

/**
 * The goal's result card needs a fresh check at the revision the last review saw, and running a project's command is
 * the person's act alone. So the Lead page asks for it exactly when a review has approved a revision, the project
 * declares a check that can run, and no run of that check is recorded at that revision. Nothing here runs anything.
 */
export const leadCheckAsk = (intents: readonly Pick<Intent, 'id' | 'role' | 'state'>[], evidence: BoardEvidence | undefined): LeadCheckAsk | null => {
  if (!evidence) return null
  const name = evidence.checks.includes('verify') ? 'verify' : evidence.checks[0]
  const implementation = intents.filter(one => one.role === 'implement' && one.state === 'done').at(-1)
  if (!name || !implementation) return null
  const facts = [...evidence.cards].sort((a, b) => a.card - b.card).flatMap(card => card.facts.map(view => view.record.fact))
  const review = facts.filter(fact => fact.kind === 'review').at(-1)
  if (review?.kind !== 'review' || review.verdict !== 'approve') return null
  const ran = facts.some(fact => fact.kind === 'check' && fact.name === name && fact.at === review.at)
  return ran ? null : { card: implementation.id, name }
}
