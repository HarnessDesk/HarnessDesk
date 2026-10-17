import { clientTierFor, parseLeadCardDecisionFor, type LeadAcceptanceContract, type LeadCard, type LeadPermissionPolicy } from '@harnessdesk/protocol'
import { applyLeadPolicyDecision, compareLeadPolicyAuthority } from './permissions.js'
import { parseLeadJournalRecord, type LeadArgumentSummary, type LeadAttemptOutcome, type LeadJournalRecord, type LeadRunIdentity } from './journal.js'

export interface LeadAttemptState {
  readonly id: string; readonly correlationId: string; readonly method: string; readonly action: string | null
  readonly kind: 'read' | 'mutation' | 'invalid'; readonly stepId: string | null; readonly arguments: LeadArgumentSummary
  readonly phase: 'attempted' | 'decided' | 'started' | 'finished'; readonly effect: 'allow' | 'ask' | 'deny' | null
  readonly dispatched: boolean; readonly outcome: LeadAttemptOutcome | null
}
export interface LeadStepState { readonly id: string; readonly state: 'pending' | 'admitted' | 'completed' | 'uncertain'; readonly attemptId: string | null }
export interface LeadState {
  readonly seq: number
  readonly phase: 'draft' | 'awaiting-plan' | 'running' | 'waiting-for-user' | 'accepted' | 'declined' | 'stopped'
  readonly policy: LeadPermissionPolicy | null
  readonly contract: LeadAcceptanceContract | null
  readonly consent: { readonly contractDigest: string; readonly contractRevision: number; readonly policyRevision: number; readonly expiresAt: number } | null
  readonly cards: readonly LeadCard[]
  readonly decidedCards: readonly string[]
  readonly steps: readonly LeadStepState[]
  readonly attempts: readonly LeadAttemptState[]
  readonly teams: readonly string[]
  readonly runs: readonly LeadRunIdentity[]
}
export const initialLeadState = (): LeadState => ({ seq: 0, phase: 'draft', policy: null, contract: null, consent: null,
  cards: [], decidedCards: [], steps: [], attempts: [], runs: [], teams: [] })
const ensure = (condition: unknown): void => { if (!condition) throw new Error('lead-journal-transition') }
const cardKey = (card: { id: string; revision: number }) => `${card.id}:${card.revision}`

/** Replay is a pure reducer. A syntactically valid line is not enough: every transition
 * must be possible from its durable prefix, with no second admission of the same step. */
export const reduceLeadRecord = (previous: LeadState, value: unknown): LeadState => {
  const event = parseLeadJournalRecord(value)
  ensure(event.seq === previous.seq + 1)
  let state: LeadState = { ...previous, seq: event.seq }
  const updateAttempt = (id: string, update: (attempt: LeadAttemptState) => LeadAttemptState) => {
    const attempt = state.attempts.find(attempt => attempt.id === id)
    ensure(attempt)
    state = { ...state, attempts: state.attempts.map(attempt => attempt.id === id ? update(attempt) : attempt) }
  }
  const complete = (id: string, identity: LeadRunIdentity) => {
    const attempt = state.attempts.find(attempt => attempt.id === id)!
    ensure(attempt.method === 'flow/start-goal' && identity.correlationId === attempt.correlationId && attempt.stepId !== null)
    ensure(!state.runs.some(run => run.runId === identity.runId && run.correlationId !== identity.correlationId))
    state = { ...state, teams: [...new Set([...state.teams, identity.teamId])], runs: [...state.runs.filter(run => run.correlationId !== identity.correlationId), identity],
      steps: state.steps.map(step => step.id === attempt.stepId ? { ...step, state: 'completed' as const } : step) }
  }
  switch (event.type) {
    case 'policy':
      ensure(state.policy === null || event.policy.revision > state.policy.revision &&
        ['narrowing', 'unchanged'].includes(compareLeadPolicyAuthority(state.policy, event.policy)))
      state = { ...state, policy: event.policy }; break
    case 'card': {
      const old = state.cards.find(card => card.id === event.card.id)
      ensure(!old || event.card.revision > old.revision)
      ensure(old || state.cards.length < 64)
      state = { ...state, cards: [...state.cards.filter(card => card.id !== event.card.id), event.card] }
      if (event.card.type === 'plan') state = { ...state, phase: 'awaiting-plan' }
      break
    }
    case 'card-decision': {
      const card = state.cards.find(card => card.id === event.decision.cardId)
      ensure(card && !state.decidedCards.includes(cardKey(card)))
      const decision = parseLeadCardDecisionFor(event.decision, card)
      ensure(card)
      if (card!.type === 'plan') {
        ensure(state.policy?.revision === card!.contract.policyRevision && !state.steps.some(step => step.state !== 'pending'))
        if (decision.choice === 'approve') {
          ensure(event.expiresAt !== null && event.expiresAt > 0)
          state = { ...state, contract: card!.contract, phase: 'running', teams: [], runs: [],
            consent: { contractDigest: card!.contract.digest, contractRevision: card!.contract.revision,
              policyRevision: card!.contract.policyRevision, expiresAt: event.expiresAt! },
            steps: card!.contract.steps.map(step => ({ id: step.id, state: 'pending', attemptId: null })) }
        } else state = { ...state, phase: 'declined' }
      } else if (card!.type === 'permission-change') {
        ensure(state.policy)
        state = { ...state, policy: applyLeadPolicyDecision(event.decision, card, state.policy!, state.contract?.digest ?? null) }
      } else {
        ensure(card!.contractDigest === state.contract?.digest)
        state = { ...state, phase: decision.choice === 'decline' ? 'declined' : card!.type === 'result' ? 'accepted' : 'running' }
      }
      state = { ...state, decidedCards: [...state.decidedCards, cardKey(card!)] }
      break
    }
    case 'team-approved':
      ensure(state.contract?.digest === event.contractDigest && !state.teams.includes(event.teamId))
      state = { ...state, teams: [...state.teams, event.teamId] }; break
    case 'stop': state = { ...state, phase: 'stopped' }; break
    case 'attempt': {
      const tier = clientTierFor(event.method, event.action === null ? {} : { action: event.action })
      ensure(event.kind === (tier === 'read' ? 'read' : tier === 'run' ? 'mutation' : 'invalid'))
      ensure(event.id === event.correlationId)
      ensure(!state.attempts.some(attempt => attempt.id === event.id || attempt.correlationId === event.correlationId))
      ensure(event.policyRevision === (state.policy?.revision ?? null) && event.contractRevision === (state.contract?.revision ?? null))
      state = { ...state, attempts: [...state.attempts, { id: event.id, correlationId: event.correlationId, method: event.method,
        action: event.action, kind: event.kind, stepId: event.stepId, arguments: event.arguments,
        phase: 'attempted', effect: null, dispatched: false, outcome: null }] }; break
    }
    case 'decision':
      updateAttempt(event.id, attempt => { ensure(attempt.phase === 'attempted'); return { ...attempt, phase: 'decided', effect: event.effect } }); break
    case 'dispatch-start': {
      const attempt = state.attempts.find(attempt => attempt.id === event.id)
      ensure(attempt?.phase === 'decided' && (!event.dispatched || attempt.effect === 'allow' && attempt.kind !== 'invalid'))
      if (event.dispatched && attempt!.method === 'flow/start-goal') {
        const step = state.steps.find(step => step.id === attempt!.stepId)
        ensure(state.phase === 'running' && step?.state === 'pending' && state.steps.find(step => step.state !== 'completed')?.id === step.id)
        state = { ...state, steps: state.steps.map(step => step.id === attempt!.stepId ? { ...step, state: 'admitted', attemptId: event.id } : step) }
      }
      updateAttempt(event.id, attempt => ({ ...attempt, phase: 'started', dispatched: event.dispatched })); break
    }
    case 'result': {
      const attempt = state.attempts.find(attempt => attempt.id === event.id)
      ensure(attempt?.phase === 'started')
      ensure(attempt!.dispatched ? ['succeeded', 'failed', 'uncertain'].includes(event.outcome) : ['denied', 'asked', 'malformed', 'interrupted'].includes(event.outcome))
      ensure(event.identity === null || event.outcome === 'succeeded')
      if (event.outcome === 'succeeded' && attempt!.method === 'flow/start-goal') { ensure(event.identity); complete(event.id, event.identity!) }
      else ensure(event.identity === null)
      updateAttempt(event.id, attempt => ({ ...attempt, phase: 'finished', outcome: event.outcome }))
      if (event.outcome === 'uncertain' && attempt!.kind !== 'read') state = { ...state, phase: 'waiting-for-user',
        steps: state.steps.map(step => step.attemptId === event.id ? { ...step, state: 'uncertain' } : step) }
      break
    }
    case 'reconciliation': {
      const attempt = state.attempts.find(attempt => attempt.id === event.id)
      ensure(attempt?.phase === 'finished' && attempt.outcome === 'uncertain' && attempt.kind === 'mutation')
      if (event.identity !== null) {
        complete(event.id, event.identity)
        updateAttempt(event.id, attempt => ({ ...attempt, outcome: 'succeeded' }))
        if (!state.attempts.some(attempt => attempt.kind === 'mutation' && attempt.outcome === 'uncertain')) state = { ...state, phase: 'running' }
      } else state = { ...state, phase: 'waiting-for-user' }
      break
    }
  }
  // An observed result can resolve uncertainty, never revoke a durable terminal decision.
  if (['stopped', 'accepted', 'declined'].includes(previous.phase)) state = { ...state, phase: previous.phase }
  return state
}
export const replayLeadJournal = (records: readonly LeadJournalRecord[]): LeadState => records.reduce(reduceLeadRecord, initialLeadState())
