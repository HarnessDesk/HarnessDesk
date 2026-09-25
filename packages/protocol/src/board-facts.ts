import type { CardEvidence, EvidenceView } from './evidence.js'
import type { FlowRole, FlowRun } from './flow.js'
import type { FlowExecution } from './flow-policy.js'
import type { Intent } from './team.js'

import { checkPassed, ciVerdict, isCurrent } from './evidence-status.js'

export type FactColumn = 'todo' | 'working' | 'needs' | 'review' | 'ready' | 'aside'

export const FACT_COLUMNS: readonly { readonly id: FactColumn; readonly title: string }[] = [
  { id: 'todo', title: 'To do' },
  { id: 'working', title: 'Working' },
  { id: 'needs', title: 'Needs you' },
  { id: 'review', title: 'In review' },
  { id: 'ready', title: 'Ready' },
  { id: 'aside', title: 'Set aside' },
]

export interface Placement {
  readonly column: FactColumn
  readonly why: string | null
}

export interface PlaceInput {
  readonly intent: Intent
  readonly evidence: CardEvidence | undefined
  readonly stranded: boolean
  readonly holderWaits: boolean
  readonly forPerson: boolean
}

export const flowRoleOf = (intent: Intent, run: FlowRun | undefined): FlowRole | null => {
  if (!intent.role || !run) return null
  if (!run.rounds.some((round) => round.intents.includes(intent.id))) return null
  return run.flow.roles.find((one) => one.id === intent.role) ?? null
}

/** What a card is to the flow that opened it: whose step, and the words that step may answer. */
export interface FlowStep {
  readonly kind: FlowRole['kind']
  readonly outcomes: readonly string[]
}

/**
 * The step a live flow addressed this card to — an old-format run on a room,
 * or a run on a Goal — only when one of that run's own rounds opened it. A
 * person's step is answered with its declared words; a card no live run
 * opened is none. The board and the Goal's own activity both read this, so
 * a card that needs its person is drawn and counted the same way.
 */
export const flowStepOf = (
  intent: Intent,
  run: FlowRun | undefined,
  executions: readonly FlowExecution[],
): FlowStep | null => {
  const legacy = flowRoleOf(intent, run)
  if (legacy) return { kind: legacy.kind, outcomes: legacy.outcomes }
  if (!intent.role) return null
  for (const execution of executions) {
    if (execution.state !== 'running' && execution.state !== 'stalled') continue
    if (execution.document.format !== 'agents') continue
    if (!execution.rounds.some((round) => round.role === intent.role && round.cards.includes(intent.id))) continue
    const role = execution.document.flow.roles.find((one) => one.id === intent.role)
    if (!role) continue
    return { kind: role.kind, outcomes: role.kind === 'person' ? role.outcomes : [] }
  }
  return null
}

const subjectOf = (view: EvidenceView): string | null => {
  const fact = view.record.fact
  switch (fact.kind) {
    case 'check':
      return fact.name
    case 'ci':
      return 'CI'
    case 'pr':
      return `PR #${fact.number}`
    default:
      return null
  }
}

const notCurrent = (view: EvidenceView): string | null => {
  const subject = subjectOf(view)
  if (subject === null || isCurrent(view.freshness)) return null
  return view.freshness.state === 'unknown' ? `${subject} unknown` : `${subject} out of date`
}

const settled = (evidence: CardEvidence | undefined): Placement => {
  const facts = evidence?.facts ?? []
  const current = facts.filter((view) => isCurrent(view.freshness))
  for (const view of current) {
    const fact = view.record.fact
    if (fact.kind === 'check' && !checkPassed(fact)) return { column: 'needs', why: `${fact.name} failed` }
    if (fact.kind === 'ci' && ciVerdict(fact.checks) === 'failed') return { column: 'needs', why: 'CI failed' }
    if (fact.kind === 'ci' && ciVerdict(fact.checks) === 'cancelled') return { column: 'needs', why: 'CI cancelled' }
    if (fact.kind === 'pr' && fact.state === 'closed') return { column: 'needs', why: `PR #${fact.number} closed` }
  }
  for (const view of current) {
    const fact = view.record.fact
    if (fact.kind === 'pr' && fact.state === 'merged') return { column: 'ready', why: null }
    if (fact.kind === 'check' && checkPassed(fact)) return { column: 'ready', why: null }
    if (fact.kind === 'ci' && ciVerdict(fact.checks) === 'passed') return { column: 'ready', why: null }
  }
  const running = evidence?.running[0]
  if (running) return { column: 'review', why: `${running.name} running` }
  for (const view of current) {
    const fact = view.record.fact
    if (fact.kind === 'ci' && ciVerdict(fact.checks) === 'running') return { column: 'review', why: 'CI running' }
    if (fact.kind === 'pr' && fact.state === 'open') return { column: 'review', why: `PR #${fact.number} open` }
  }
  for (const view of facts) {
    const why = notCurrent(view)
    if (why !== null) return { column: 'needs', why }
  }
  return { column: 'needs', why: 'nothing checked' }
}

export const placeCard = ({ intent, evidence, stranded, holderWaits, forPerson }: PlaceInput): Placement => {
  switch (intent.state) {
    case 'abandoned':
      return { column: 'aside', why: null }
    case 'blocked':
      return intent.blockedBy === 'hand' ? { column: 'needs', why: 'stopped' } : { column: 'todo', why: null }
    case 'open':
      return forPerson ? { column: 'needs', why: 'needs your answer' } : { column: 'todo', why: null }
    case 'claimed':
      if (stranded) return { column: 'needs', why: null }
      if (holderWaits) return { column: 'needs', why: 'waiting on you' }
      return { column: 'working', why: null }
    case 'done':
      return settled(evidence)
  }
}
