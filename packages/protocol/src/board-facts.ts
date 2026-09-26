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
  /**
   * The run that addressed this card to its person is still asking
   * (`FlowStep.live`) — `running` or `stalled`, never `settled` or
   * `stopped`. An unanswered card (`open` or `claimed`) is only the
   * person's own step while this holds; a finished (`done`) card keeps its
   * role whatever this is, since nothing further can undo an answer already
   * given.
   */
  readonly live: boolean
  /**
   * The run that opened this card has stopped for its person
   * (`FlowStep.stopped`): nothing moves the card on until they act, so it is
   * theirs — drawn in Needs you, as the Goal's own header already reads it.
   */
  readonly runStopped: boolean
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
  /** Whether the run that opened it is stopped for a person (`stalled`), rather than running. */
  readonly stopped: boolean
  /**
   * Whether the run that opened this card is still asking anything of
   * anyone — `running` or `stalled` — as opposed to `settled` or `stopped`
   * for good. See `PlaceInput.live`.
   */
  readonly live: boolean
}

/**
 * The step a flow addressed this card to — an old-format run on a room, or a
 * run on a Goal — only when one of that run's own rounds opened it. A
 * person's step is answered with its declared words; a card no run opened is
 * none. The board and the Goal's own activity both read this, so a card that
 * needs its person is drawn and counted the same way.
 *
 * A round's card keeps its role for as long as the Goal does, whatever the
 * run that opened it is doing now: `running`, `stalled`, `settled` or
 * `stopped` are all read the same way here, and `kind`/`outcomes`/`stopped`
 * never depend on which. A flow settling is the ordinary way one ends, and
 * settling must not erase which of its cards was the person's own decision
 * — otherwise the very card that just finished it falls back to being read
 * as an unchecked diff (`placeCard`'s `settled` evidence path, which has no
 * fact for "a person answered this") and lands back in Needs you for good
 * (#1022).
 *
 * `live` is the other half: a card nobody has answered yet (`open` or
 * `claimed`) is only the person's *open* step while the run that opened it
 * is still asking — `running` or `stalled`. Once it `settled` or `stopped`,
 * nothing is asking any more, so an unanswered card is no longer theirs to
 * answer and answering it would do nothing; a `done` card is unaffected,
 * since it already carries the answer it was given.
 */
export const flowStepOf = (
  intent: Intent,
  run: FlowRun | undefined,
  executions: readonly FlowExecution[],
): FlowStep | null => {
  const legacy = flowRoleOf(intent, run)
  if (legacy) {
    return {
      kind: legacy.kind,
      outcomes: legacy.outcomes,
      stopped: run?.state === 'stalled',
      live: run?.state === 'running' || run?.state === 'stalled',
    }
  }
  if (!intent.role) return null
  for (const execution of executions) {
    if (execution.document.format !== 'agents') continue
    if (!execution.rounds.some((round) => round.role === intent.role && round.cards.includes(intent.id))) continue
    const role = execution.document.flow.roles.find((one) => one.id === intent.role)
    if (!role) continue
    return {
      kind: role.kind,
      outcomes: role.kind === 'person' ? role.outcomes : [],
      stopped: execution.state === 'stalled',
      live: execution.state === 'running' || execution.state === 'stalled',
    }
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

export const placeCard = ({ intent, evidence, stranded, holderWaits, forPerson, live, runStopped }: PlaceInput): Placement => {
  switch (intent.state) {
    case 'abandoned':
      return { column: 'aside', why: null }
    case 'blocked':
      return intent.blockedBy === 'hand' ? { column: 'needs', why: 'stopped' } : { column: 'todo', why: null }
    case 'open':
      // Unanswered: it is the person's step only while the run that opened
      // it is still live. A settled or stopped run is asking nothing more.
      if (forPerson && live) return { column: 'needs', why: 'needs your answer' }
      return runStopped ? { column: 'needs', why: 'run stopped' } : { column: 'todo', why: null }
    case 'claimed':
      // Also unanswered: same `live` requirement, though nothing here reads
      // `forPerson` directly — a claimed card falls through to the same
      // stranded/holderWaits/runStopped reading whether or not it is a
      // person's step.
      if (stranded) return { column: 'needs', why: null }
      if (holderWaits) return { column: 'needs', why: 'waiting on you' }
      if (runStopped) return { column: 'needs', why: 'run stopped' }
      return { column: 'working', why: null }
    case 'done':
      /*
       * A flow's person step is answered with its own outcome, never with
       * evidence — a reviewer's "approve" has no check or PR to point at, and
       * `settled` reading that as "nothing checked" would put a finished
       * card back in Needs you, exactly where its still-unfinished siblings
       * belong. `forPerson` is the same signal `open` and `claimed` read,
       * but unlike them this does not also require `live`: a `done` card's
       * state is the last word on it whatever the run that opened it is
       * doing now — running, stalled, settled or gone (#1022) — which is why
       * this checks it before, and instead of, `settled`.
       */
      if (forPerson) return { column: 'ready', why: null }
      return settled(evidence)
  }
}
