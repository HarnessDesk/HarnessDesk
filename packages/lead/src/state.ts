import { clientTierFor, parseLeadCardDecisionFor, type LeadAcceptanceContract, type LeadCard, type LeadPermissionPolicy } from '@harnessdesk/protocol'
import { applyLeadPolicyDecision, compareLeadPolicyAuthority } from './permissions.js'
import { parseLeadJournalRecord, type LeadArgumentSummary, type LeadAttemptOutcome, type LeadJournalRecord, type LeadRunIdentity } from './journal.js'
import { reduceLeadBudget, releaseLeadStart, applyLeadBudgetCard, applyLeadBudgetCaps, type LeadBudgetLedger } from './budget.js'

export interface LeadAttemptState {
  readonly id: string; readonly correlationId: string; readonly method: string; readonly action: string | null
  readonly kind: 'read' | 'mutation' | 'invalid'; readonly stepId: string | null; readonly arguments: LeadArgumentSummary
  readonly phase: 'attempted' | 'decided' | 'started' | 'finished'; readonly effect: 'allow' | 'ask' | 'deny' | null
  readonly dispatched: boolean; readonly outcome: LeadAttemptOutcome | null
  readonly recoveryReported: boolean; readonly evidence: string | null
}
export interface LeadStepState { readonly id: string; readonly state: 'pending' | 'admitted' | 'started' | 'uncertain'; readonly attemptId: string | null }
export interface LeadState {
  readonly budget: LeadBudgetLedger | null
  /** Journal sequence of the latched stop whose idempotent cancellation effects need acknowledgement. */
  readonly stopEffectsPending: number | null
  readonly seq: number
  readonly phase: 'draft' | 'awaiting-plan' | 'running' | 'waiting-for-user' | 'accepted' | 'declined' | 'stopped'
  readonly policy: LeadPermissionPolicy | null
  readonly contract: LeadAcceptanceContract | null
  readonly consent: { readonly contractDigest: string; readonly contractRevision: number; readonly policyRevision: number; readonly expiresAt: number } | null
  readonly cards: readonly LeadCard[]
  readonly decidedCards: readonly string[]
  readonly steps: readonly LeadStepState[]
  readonly attempts: ReadonlyMap<string, LeadAttemptState>
  readonly recoveryBlocked: boolean
  readonly cardRevisions: Readonly<Record<string, number>>
  readonly teams: readonly string[]
  readonly runs: readonly LeadRunIdentity[]
}
export const initialLeadState = (): LeadState => ({ seq: 0, phase: 'draft', policy: null, contract: null, consent: null, budget: null, stopEffectsPending: null,
  cards: [], decidedCards: [], steps: [], attempts: new Map(), recoveryBlocked: false, cardRevisions: {}, runs: [], teams: [] })
const ensure = (condition: unknown): void => { if (!condition) throw new Error('lead-journal-transition') }
const cardKey = (card: { id: string; revision: number }) => `${card.id}:${card.revision}`

/** Card decisions, not phase changes or recovery, release the plan fence. */
export const hasPendingLeadPlan = (state: LeadState): boolean => state.cards.some(card => card.type === 'plan' && !state.decidedCards.includes(cardKey(card)))

export const assertPlanApprovable = (state: LeadState, contract: LeadAcceptanceContract): void => {
  ensure(state.policy?.revision === contract.policyRevision)
  ensure(state.contract === null || contract.revision > state.contract.revision)
  // An admitted attempt may already have spent, even when its response is uncertain.
  const locked = state.steps.filter(step => step.state !== 'pending')
  if (locked.length) {
    ensure(contract.project.id === state.contract?.project.id && contract.project.path === state.contract.project.path)
    ensure(locked.every((step, index) => step.id === contract.steps[index]?.id &&
      JSON.stringify(contract.steps[index]) === JSON.stringify(state.contract?.steps[index])))
  }
}
const managementPhase = (state: LeadState): LeadState['phase'] => state.phase !== 'awaiting-plan' ? state.phase :
  [...state.attempts.values()].some(attempt => attempt.kind === 'mutation' && attempt.outcome === 'uncertain') ? 'waiting-for-user' : 'running'

/** Replay is a pure reducer. A syntactically valid line is not enough: every transition
 * must be possible from its durable prefix, with no second admission of the same step. */
export const reduceLeadRecord = (previous: LeadState, value: unknown): LeadState => {
  const event = parseLeadJournalRecord(value)
  ensure(event.seq === previous.seq + 1)
  let state: LeadState = { ...previous, seq: event.seq }
  const updateAttempt = (id: string, update: (attempt: LeadAttemptState) => LeadAttemptState) => {
    const attempt = state.attempts.get(id)
    ensure(attempt)
    const attempts = new Map(state.attempts); attempts.set(id, update(attempt!)); state = { ...state, attempts }
  }
  const complete = (id: string, identity: LeadRunIdentity) => {
    const attempt = state.attempts.get(id)!
    ensure(attempt.method === 'flow/start-goal' && identity.correlationId === attempt.correlationId && attempt.stepId !== null)
    ensure(!state.runs.some(run => run.runId === identity.runId && run.correlationId !== identity.correlationId))
    state = { ...state, teams: [...new Set([...state.teams, identity.teamId])], runs: [...state.runs.filter(run => run.correlationId !== identity.correlationId), identity],
      steps: state.steps.map(step => step.id === attempt.stepId ? { ...step, state: 'started' as const } : step) }
  }
  const releaseStart = (id: string) => {
    if (state.budget) state = { ...state, budget: releaseLeadStart(state.budget, id) }
    state = { ...state, steps: state.steps.map(step => step.attemptId === id ? { ...step, state: 'pending' as const, attemptId: null } : step) }
  }
  switch (event.type) {
    case 'budget': {
      if (['reserve', 'start'].includes(event.event.type)) ensure(!['stopped', 'accepted', 'declined'].includes(state.phase))
      if (event.event.type === 'round' && ['stopped', 'accepted', 'declined'].includes(state.phase)) {
        const roundEvent = event.event
        // Recording an already admitted host round is bookkeeping, not new work.
        ensure(state.budget?.rounds.some(round => round.executionId === roundEvent.executionId &&
          (round.roundId === roundEvent.roundId || round.startId !== null && round.roundId === null)))
      }
      const executionId = event.event.type === 'bind' ? event.event.executionId : null
      const binding = state.runs.find(run => run.runId === executionId)
      let budget = reduceLeadBudget(state.budget, binding ? { ...event.event, startId: binding.correlationId } : event.event)
      if (previous.phase === 'stopped' && budget.stop === null) budget = reduceLeadBudget(budget, { version: 1, type: 'stop', now: budget.now, reason: 'cancelled' })
      state = { ...state, budget, phase: budget.stop ? 'stopped' : state.phase }; break
    }
    case 'policy':
      ensure(state.policy === null || event.policy.revision > state.policy.revision &&
        ['narrowing', 'unchanged'].includes(compareLeadPolicyAuthority(state.policy, event.policy)))
      state = { ...state, policy: event.policy }; break
    case 'card': {
      const old = state.cards.find(card => card.id === event.card.id)
      ensure(!old || event.card.revision > old.revision && event.card.type === old.type)
      ensure(old || state.cards.length < 64)
      ensure((state.cardRevisions[event.card.id] ?? 0) < 32)
      state = { ...state, cards: [...state.cards.filter(card => card.id !== event.card.id), event.card], cardRevisions: { ...state.cardRevisions, [event.card.id]: (state.cardRevisions[event.card.id] ?? 0) + 1 } }
      if (event.card.type === 'plan') state = { ...state, phase: 'awaiting-plan' }
      break
    }
    case 'card-decision': {
      const card = state.cards.find(card => card.id === event.decision.cardId)
      ensure(card && !state.decidedCards.includes(cardKey(card)))
      const decision = parseLeadCardDecisionFor(event.decision, card)
      ensure(card)
      if (card!.type === 'plan') {
        if (decision.choice === 'approve') {
          assertPlanApprovable(state, card!.contract)
          ensure(event.expiresAt !== null && event.expiresAt > 0)
          const contract = card!.contract
          const locked = state.steps.filter(step => step.state !== 'pending')
          state = { ...state, contract, phase: 'running', teams: locked.length ? state.teams : [], runs: locked.length ? state.runs : [],
            consent: { contractDigest: card!.contract.digest, contractRevision: card!.contract.revision,
              policyRevision: card!.contract.policyRevision, expiresAt: event.expiresAt! },
            steps: contract.steps.map(step => locked.find(existing => existing.id === step.id) ?? { id: step.id, state: 'pending', attemptId: null }),
            decidedCards: [...new Set([...state.decidedCards, ...state.cards.filter(other => other.type === 'plan' && other.id !== card!.id &&
              other.contract.revision <= contract.revision).map(cardKey)])] }
          if (state.budget) state = { ...state, budget: applyLeadBudgetCaps(state.budget, contract.caps) }
        } else state = { ...state, phase: state.contract === null ? 'declined' : managementPhase(state) }
      } else if (card!.type === 'budget-change') {
        ensure(state.budget && card!.contractDigest === (state.contract?.digest ?? null))
        state = { ...state, budget: applyLeadBudgetCard(state.budget!, event.decision, card!) }
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
      ensure(state.contract?.digest === event.contractDigest && !state.teams.includes(event.teamId) && state.teams.length < 4096)
      state = { ...state, teams: [...state.teams, event.teamId] }; break
    case 'stop': state = { ...state, phase: 'stopped', budget: state.budget ? reduceLeadBudget(state.budget,
      { version: 1, type: 'stop', now: state.budget.now, reason: 'cancelled' }) : null }; break
    case 'stop-effects-done':
      ensure(state.stopEffectsPending === event.stopSeq); state = { ...state, stopEffectsPending: null }; break
    case 'recovery-block': state = { ...state, recoveryBlocked: true }; break
    case 'recovery-resolved': state = { ...state, recoveryBlocked: false }; break
    case 'recovery-report': updateAttempt(event.id, attempt => { ensure(!attempt.recoveryReported); return { ...attempt, recoveryReported: true } }); break
    case 'attempt': {
      const tier = clientTierFor(event.method, event.action === null ? {} : { action: event.action })
      ensure(event.kind === (tier === 'read' ? 'read' : tier === 'run' ? 'mutation' : 'invalid'))
      ensure(event.id === event.correlationId)
      ensure(!state.attempts.has(event.id) && !state.runs.some(run => run.correlationId === event.id))
      ensure(event.policyRevision === (state.policy?.revision ?? null) && event.contractRevision === (state.contract?.revision ?? null))
      state = { ...state, attempts: new Map([...state.attempts, [event.id, { id: event.id, correlationId: event.correlationId, method: event.method,
        action: event.action, kind: event.kind, stepId: event.stepId, arguments: event.arguments,
        phase: 'attempted', effect: null, dispatched: false, outcome: null, recoveryReported: false, evidence: null }]]) }; break
    }
    case 'decision':
      updateAttempt(event.id, attempt => { ensure(attempt.phase === 'attempted'); return { ...attempt, phase: 'decided', effect: event.effect } }); break
    case 'dispatch-start': {
      const attempt = state.attempts.get(event.id)
      ensure(attempt?.phase === 'decided' && (!event.dispatched || attempt.effect === 'allow' && attempt.kind !== 'invalid'))
      if (event.dispatched && attempt!.kind === 'mutation' && hasPendingLeadPlan(state))
        ensure(attempt!.method === 'flow/execution/stop' || attempt!.method === 'team/intent' && attempt!.action === 'abandon')
      if (event.dispatched && attempt!.method === 'flow/start-goal') {
        const step = state.steps.find(step => step.id === attempt!.stepId)
        ensure(state.phase === 'running' && !hasPendingLeadPlan(state) && step?.state === 'pending' && state.steps.find(step => step.state !== 'started')?.id === step.id)
        if (state.budget) state = { ...state, budget: reduceLeadBudget(state.budget, { version: 1, type: 'start', now: state.budget.now, startId: event.id }) }
        state = { ...state, steps: state.steps.map(step => step.id === attempt!.stepId ? { ...step, state: 'admitted', attemptId: event.id } : step) }
      }
      updateAttempt(event.id, attempt => ({ ...attempt, phase: 'started', dispatched: event.dispatched })); break
    }
    case 'result': {
      const attempt = state.attempts.get(event.id)
      ensure(attempt?.phase === 'started')
      ensure(attempt!.dispatched ? ['succeeded', 'failed', 'uncertain'].includes(event.outcome) : ['denied', 'asked', 'malformed', 'interrupted'].includes(event.outcome))
      ensure(event.identity === null || event.outcome === 'succeeded')
      if (event.outcome === 'succeeded' && attempt!.method === 'flow/start-goal') { ensure(event.identity); complete(event.id, event.identity!) }
      else ensure(event.identity === null)
      if (event.outcome === 'failed' && attempt!.method === 'flow/start-goal') releaseStart(event.id)
      updateAttempt(event.id, attempt => ({ ...attempt, phase: 'finished', outcome: event.outcome }))
      if (event.outcome === 'uncertain' && attempt!.kind !== 'read') state = { ...state, phase: 'waiting-for-user',
        steps: state.steps.map(step => step.attemptId === event.id ? { ...step, state: 'uncertain' } : step) }
      break
    }
    case 'start-resolution': {
      const attempt = state.attempts.get(event.id)
      ensure(attempt?.phase === 'finished' && attempt.outcome === 'uncertain' && attempt.method === 'flow/start-goal' && attempt.evidence !== null)
      if (event.identity === null) releaseStart(event.id)
      else {
        complete(event.id, event.identity)
        ensure(state.budget)
        state = { ...state, budget: reduceLeadBudget(state.budget, { version: 1, type: 'bind', now: state.budget!.now,
          startId: event.id, goalId: event.goalId, executionId: event.identity.runId }) }
      }
      updateAttempt(event.id, attempt => ({ ...attempt, outcome: event.identity ? 'succeeded' : 'failed' }))
      if (![...state.attempts.values()].some(attempt => attempt.kind === 'mutation' && attempt.outcome === 'uncertain')) state = { ...state, phase: 'running' }
      break
    }
    case 'reconciliation': {
      const attempt = state.attempts.get(event.id)
      ensure(attempt?.phase === 'finished' && attempt.outcome === 'uncertain' && attempt.kind === 'mutation')
      ensure(attempt!.evidence !== event.evidence)
      updateAttempt(event.id, attempt => ({ ...attempt, evidence: event.evidence }))
      if (event.identity !== null) {
        complete(event.id, event.identity)
        updateAttempt(event.id, attempt => ({ ...attempt, outcome: 'succeeded' }))
        if (![...state.attempts.values()].some(attempt => attempt.kind === 'mutation' && attempt.outcome === 'uncertain')) state = { ...state, phase: 'running' }
      } else state = { ...state, phase: 'waiting-for-user' }
      break
    }
  }
  // Retain unresolved effects and a bounded recent audit index; durable frames retain the full audit.
  if (state.attempts.size > 64) {
    const attempts = new Map(state.attempts)
    for (const [id, attempt] of attempts) {
      if (attempts.size <= 64) break
      if (attempt.phase === 'finished' && (attempt.outcome !== 'uncertain' && attempt.outcome !== 'interrupted' || attempt.recoveryReported)) attempts.delete(id)
    }
    state = { ...state, attempts }
  }
  if (!['stopped', 'accepted', 'declined'].includes(state.phase) && hasPendingLeadPlan(state)) state = { ...state, phase: 'awaiting-plan' }
  else if (event.type === 'card-decision' && event.decision.cardType === 'plan' && event.decision.choice === 'approve' &&
    [...state.attempts.values()].some(attempt => attempt.kind === 'mutation' && attempt.outcome === 'uncertain')) state = { ...state, phase: 'waiting-for-user' }
  // Accepting an already-reviewed result spends nothing. It may finish a stopped
  // thread; the monetary latch continues to prohibit all new work.
  const acceptsResult = previous.phase === 'stopped' && previous.budget?.stop && ['budget', 'rounds'].includes(previous.budget.stop.reason) &&
    event.type === 'card-decision' && event.decision.cardType === 'result' && event.decision.choice === 'accept'
  if (['stopped', 'accepted', 'declined'].includes(previous.phase) && !acceptsResult) state = { ...state, phase: previous.phase }
  if (state.budget?.stop && !['accepted', 'declined'].includes(state.phase)) state = { ...state, phase: 'stopped' }
  // Discovery is a new cancellation generation, even if an older cleanup is
  // currently running or has already acknowledged the original stop.
  const discovered = state.runs.some(run => !previous.runs.some(old => old.runId === run.runId)) ||
    (state.budget?.executionIds.some(id => !previous.budget?.executionIds.includes(id)) ?? false)
  const stopped = state.budget?.stop || previous.phase === 'stopped'
  if (state.budget?.stop && !previous.budget?.stop || discovered && stopped ||
    event.type === 'stop' && previous.phase !== 'stopped' && !previous.budget?.stop)
    state = { ...state, stopEffectsPending: event.seq }
  return state
}
export const replayLeadJournal = (records: readonly LeadJournalRecord[]): LeadState => records.reduce(reduceLeadRecord, initialLeadState())
