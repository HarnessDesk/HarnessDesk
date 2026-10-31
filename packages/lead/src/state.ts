import { clientTierFor, parseLeadCardDecisionFor, type LeadWakeRecord, type LeadOrigin, type LeadHandback, type LeadName, type LeadFollowPreferences, type LeadPullRequest, type LeadDecisionMessage, type LeadAcceptanceContract, type LeadCard, type LeadPermissionPolicy, type LeadMessage, type LeadSendReceipt, windowLeadThread } from '@harnessdesk/protocol'
import { applyLeadPolicyDecision, compareLeadPolicyAuthority, sameLeadPolicyValues } from './permissions.js'
import { parseLeadJournalRecord, parseLeadRunEvidence, type LeadArgumentSummary, type LeadAttemptOutcome, type LeadJournalRecord, type LeadRunIdentity, type LeadPublicationOperation, type LeadOwnedPush } from './journal.js'
import { reopenLeadBudgetRound, reduceLeadBudget, releaseLeadStart, applyLeadBudgetCard, applyLeadBudgetCaps, type LeadBudgetLedger } from './budget.js'

export const LEAD_SEND_RECEIPTS = 4096

export interface LeadAttemptState {
  readonly id: string; readonly correlationId: string; readonly method: string; readonly action: string | null
  readonly kind: 'read' | 'mutation' | 'invalid'; readonly stepId: string | null; readonly arguments: LeadArgumentSummary
  readonly phase: 'attempted' | 'decided' | 'started' | 'finished'; readonly effect: 'allow' | 'ask' | 'deny' | null
  readonly dispatched: boolean; readonly outcome: LeadAttemptOutcome | null
  readonly recoveryReported: boolean; readonly evidence: string | null; readonly evidenceSeq: number | null; readonly resolutionPending: boolean
  /** A lookup contradicted this start: the window may confirm a run, never attest none. */
  readonly contested: boolean
}
export interface LeadStepState { readonly id: string; readonly state: 'pending' | 'admitted' | 'started' | 'uncertain'; readonly attemptId: string | null; readonly contractDigest: string | null }
export interface LeadState {
  /** Last non-wake journal sequence. Observation-only wakes leave this decision fence unchanged. */
  readonly decisionRevision: number
  readonly wakes: readonly LeadWakeRecord[]
  readonly origin: LeadOrigin | null
  readonly originKey: string | null
  /** New-goal sequence, so retained conversation history cannot claim a fresh draft. */
  readonly goalStartedSeq: number
  readonly handbacks: readonly LeadHandback[]
  readonly handbackLimit: boolean
  readonly ciPassed: readonly string[]
  readonly nameChosen: boolean
  readonly name: LeadName
  readonly follow: LeadFollowPreferences
  readonly pr: LeadPullRequest | null
  readonly publication: LeadPublicationOperation | null
  readonly ownedPush: LeadOwnedPush | null
  readonly decisionMessages: readonly LeadDecisionMessage[]
  readonly completedBudgets: readonly LeadBudgetLedger[]
  readonly secondLooks: readonly { readonly runId: string; readonly stopKey: string; readonly at: number }[]
  readonly budget: LeadBudgetLedger | null
  /** Journal sequence of the latched stop whose idempotent cancellation effects need acknowledgement. */
  readonly stopEffectsPending: number | null
  /** Only the host-owned person Stop event acknowledges possible ordinary-chat effects. */
  readonly chatEffectsAcknowledged: boolean
  readonly messages: readonly LeadMessage[]
  readonly olderMessages: number
  readonly sends: readonly (LeadSendReceipt & { readonly key: string })[]
  readonly seq: number
  readonly managementReason: string | null
  readonly phase: 'draft' | 'planning' | 'awaiting-plan' | 'running' | 'waiting-for-user' | 'following' | 'accepted' | 'declined' | 'stopped'
  readonly policy: LeadPermissionPolicy | null
  readonly contract: LeadAcceptanceContract | null
  readonly consent: { readonly contractDigest: string; readonly contractRevision: number; readonly policyRevision: number; readonly expiresAt: number; readonly renewalCardRevision?: number } | null
  readonly cards: readonly LeadCard[]
  /** Host-owned partial person save; replay and checkpoints retain its exact fence. */
  readonly retryResult: { readonly id: string; readonly revision: number; readonly digest: string; readonly goal: string | null } | null
  readonly decidedCards: readonly string[]
  readonly steps: readonly LeadStepState[]
  readonly attempts: ReadonlyMap<string, LeadAttemptState>
  readonly recoveryBlocked: boolean
  readonly cardPositions: Readonly<Record<string, number>>
  readonly cardRevisions: Readonly<Record<string, number>>
  readonly teams: readonly string[]
  readonly runs: readonly LeadRunIdentity[]
}
export const initialLeadState = (): LeadState => ({ decisionRevision: 0, wakes: [], secondLooks: [], origin: null, originKey: null, goalStartedSeq: 0, handbacks: [], handbackLimit: false, ciPassed: [], completedBudgets: [], follow: { checks: true, reviews: true }, pr: null, publication: null, ownedPush: null, name: 'dex', nameChosen: false, decisionMessages: [], messages: [], olderMessages: 0, sends: [], seq: 0, phase: 'draft', managementReason: null, policy: null, contract: null, consent: null, budget: null, stopEffectsPending: null, chatEffectsAcknowledged: false,
  cards: [], retryResult: null, decidedCards: [], steps: [], attempts: new Map(), recoveryBlocked: false, cardPositions: {}, cardRevisions: {}, runs: [], teams: [] })
/** A read's journal revision remains valid through observation-only wakes. Any
 * intervening decision-affecting write advances the lower bound and refuses it. */
export const leadDecisionRevisionMatches = (state: LeadState, expected: number): boolean =>
  Number.isSafeInteger(expected) && expected >= state.decisionRevision && expected <= state.seq

const ensure = (condition: unknown): void => { if (!condition) throw new Error('lead-journal-transition') }
const cardKey = (card: { id: string; revision: number }) => `${card.id}:${card.revision}`

/** Card decisions, not phase changes or recovery, release the plan fence. */
export const hasPendingLeadPlan = (state: LeadState): boolean => state.cards.some(card => card.type === 'plan' && !state.decidedCards.includes(cardKey(card)))

/** Ordinary worker dispatch stays fenced for the lifetime of an owned open PR.
 * Only the exact host-journaled running repair may dispatch on its owned run. */
export const leadWorkerDispatchBlockedByOpenPr = (state: LeadState, runId?: string): boolean => state.pr?.state === 'open' &&
  !(runId && state.pr.branchOwner !== 'person' && !state.handbackLimit && state.handbacks.some(op => op.runId === runId && op.stage === 'running'))
/** A repair result remains fenced until CI passes on the published head. */
export const leadRepairResultReady = (state: LeadState): boolean => !state.handbacks.length ||
  leadHandbackTerminal(state.handbacks.at(-1)!) && !state.handbackLimit && !!state.pr && state.pr.branchOwner !== 'person' && state.ciPassed.includes(state.pr.head) && state.pr.check?.state === 'passed' && state.pr.check.head === state.pr.head && state.pr.check.total > 0

export const leadHandbackTerminal = (op: LeadHandback): boolean => ['completed', 'failed', 'abandoned', 'withdrawn'].includes(op.stage)

/** Automatic input may reserve only a draft with no person message in this goal. */
export const canOfferAutomaticLeadGoal = (state: LeadState, key: string): boolean => !hasUncertainLeadChatEffect(state) && (canBeginLeadGoal(state) ||
  state.phase === 'draft' && state.contract === null && (state.originKey === key || state.origin === null) &&
    !state.sends.some(send => send.revision > state.goalStartedSeq) &&
    !state.messages.some(message => message.role === 'user' && message.revision > state.goalStartedSeq))

/** Earlier runs stay owned for accounting and recovery, but judge only this plan. */
export const leadPlanRuns = (state: LeadState): readonly LeadRunIdentity[] => state.runs.filter(run =>
  state.steps.some(step => step.state === 'started' && step.attemptId === run.correlationId))

/** A fresh person request can replace exhausted work, never resume a spent step. */
export const canReplaceLeadPlan = (state: LeadState): boolean => {
  if (!state.contract || !state.steps.length || state.recoveryBlocked || state.budget?.stop || state.budget?.requests.length ||
    ['stopped', 'accepted', 'declined', 'following'].includes(state.phase) || state.pr !== null || !state.steps.every(step => step.state === 'started')) return false
  if ([...state.attempts.values()].some(attempt => attempt.kind === 'mutation' &&
    (attempt.phase !== 'finished' || attempt.resolutionPending || attempt.contested || attempt.outcome === 'uncertain'))) return false
  if (state.cards.some(card => card.contractDigest === state.contract!.digest && !state.decidedCards.includes(cardKey(card)) &&
    (card.type === 'result' || card.type === 'waiting' && card.kind === 'person'))) return false
  const approved = state.cards.find(card => card.type === 'plan' && card.contractDigest === state.contract!.digest && state.decidedCards.includes(cardKey(card)))
  if (!approved || !state.messages.some(message => message.role === 'user' && message.revision > state.cardPositions[approved.id]!)) return false
  return state.steps.every(step => {
    const attempt = state.attempts.get(step.attemptId!)
    const runs = state.runs.filter(run => run.correlationId === step.attemptId)
    if (attempt?.outcome !== 'succeeded' || attempt.evidence === null || !runs.length) return false
    if (!state.messages.some(message => message.role === 'user' && message.revision > (attempt.evidenceSeq ?? state.seq))) return false
    const evidence = parseLeadRunEvidence(attempt.evidence)
    return runs.every(run => evidence.some(observed => observed.runId === run.runId && observed.teamId === run.teamId && observed.terminal))
  })
}

/** One cancellation classification for admission, replay and crash recovery. */
export const isLeadCancellation = (method: string, action: string | null): boolean =>
  method === 'lead/chat/stop' || method === 'flow/execution/stop' || method === 'team/intent' && action === 'abandon'

const isLeadChatEffect = (attempt: LeadAttemptState): boolean =>
  attempt.method === 'lead/chat/start' || attempt.method === 'lead/chat/send'

export const hasUncertainLeadChatEffect = (state: LeadState): boolean =>
  [...state.attempts.values()].some(attempt => isLeadChatEffect(attempt) && attempt.outcome === 'uncertain')

/** Chat effects bind neither Flow runs nor budget rounds. Old empty Flow lookup
 * bookkeeping may be retired, but any positive or contested evidence stays fenced. */
export const canReportLeadChatEffect = (state: LeadState, attempt: LeadAttemptState): boolean =>
  isLeadChatEffect(attempt) && attempt.phase === 'finished' && attempt.outcome === 'uncertain' &&
  !attempt.contested && !state.steps.some(step => step.attemptId === attempt.id) &&
  (attempt.evidence === null || parseLeadRunEvidence(attempt.evidence).length === 0) &&
  !state.runs.some(run => run.correlationId === attempt.correlationId) &&
  !state.budget?.rounds.some(round => round.startId === attempt.id)

/** A cancelled goal may be replaced only after cancellation and recovery are settled. */
export const canBeginLeadGoal = (state: LeadState): boolean =>
  ['stopped', 'accepted', 'declined'].includes(state.phase) && !!state.budget && state.stopEffectsPending === null &&
  (!hasUncertainLeadChatEffect(state) || state.chatEffectsAcknowledged) &&
  !state.recoveryBlocked && !state.budget.requests.length && state.completedBudgets.length < 64 &&
  [...state.attempts.values()].every(attempt => attempt.phase === 'finished' && !attempt.resolutionPending && !attempt.contested &&
    (attempt.outcome !== 'uncertain' && attempt.outcome !== 'interrupted' || attempt.recoveryReported))

export const assertPlanApprovable = (state: LeadState, contract: LeadAcceptanceContract): void => {
  ensure(state.pr === null && state.phase !== 'following')
  ensure(state.policy?.revision === contract.policyRevision)
  ensure(state.contract === null || contract.revision > state.contract.revision)
  // An admitted attempt may already have spent, even when its response is uncertain.
  const locked = state.steps.filter(step => step.state !== 'pending')
  const spent = new Set([...state.attempts.values()].filter(attempt => attempt.method === 'flow/start-goal' && attempt.dispatched &&
    attempt.outcome === 'succeeded').map(attempt => attempt.stepId))
  ensure(contract.steps.every(step => locked.some(existing => existing.id === step.id) || !spent.has(step.id)))
  if (locked.length) {
    ensure(contract.project.id === state.contract?.project.id && contract.project.path === state.contract.project.path)
    const preserves = locked.every((step, index) => step.id === contract.steps[index]?.id &&
      JSON.stringify(contract.steps[index]) === JSON.stringify(state.contract?.steps[index]))
    if (!preserves) {
      ensure(canReplaceLeadPlan(state))
      ensure(contract.steps.every(step => !spent.has(step.id)))
    }
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
    state = { ...state, steps: state.steps.map(step => step.attemptId === id ? { ...step, state: 'pending' as const, attemptId: null, contractDigest: null } : step) }
  }
  switch (event.type) {
    case 'origin':
      ensure(state.contract === null && state.runs.length === 0 && state.origin === null)
      state = { ...state, origin: event.origin, originKey: event.key ?? null }; break
    case 'handback-limit':
      ensure(state.pr?.state === 'open')
      state = { ...state, handbackLimit: true, phase: 'waiting-for-user', managementReason: 'lead-handback-limit' }; break
    case 'handback': {
      const op = event.operation, previous = state.handbacks.find(item => item.key === op.key)
      ensure(state.pr?.state === 'open' && state.pr.branchOwner !== 'person' && !state.handbackLimit &&
        !['accepted', 'declined', 'stopped'].includes(state.phase) && state.runs.some(run => run.runId === op.runId && run.teamId === op.teamId))
      if (!previous) {
        ensure(op.stage === 'prepared' && op.head === state.pr!.head && state.handbacks.length < 64 &&
          state.handbacks.every(leadHandbackTerminal) && state.follow[op.kind])
        ensure(op.kind === 'checks' ? !state.handbacks.some(item => item.kind === 'checks' && item.head === op.head && item.stage !== 'withdrawn') : state.handbacks.filter(item => item.kind === 'reviews' && item.stage !== 'withdrawn').length < 3)
        // This durable intent authorizes reopening the same owned Run. Keep
        // its identity, but retire the earlier terminal observation before the
        // host can open the repair round, including a crash before `running`.
        const owned = state.runs.find(run => run.runId === op.runId && run.teamId === op.teamId)!
        const attempt = state.attempts.get(owned.correlationId)
        if (attempt?.evidence !== null && attempt?.evidence !== undefined) {
          const rows = parseLeadRunEvidence(attempt.evidence)
          if (rows.some(row => row.runId === op.runId && row.terminal)) updateAttempt(owned.correlationId, current => ({ ...current,
            evidence: JSON.stringify(rows.map(row => row.runId === op.runId ? { ...row, terminal: false } : row)), evidenceSeq: event.seq }))
        }
      } else {
        if (op.stage === 'running') ensure(state.follow[op.kind])
        ensure(JSON.stringify({ ...previous, stage: undefined, publishedHead: undefined }) === JSON.stringify({ ...op, stage: undefined, publishedHead: undefined }))
        const transitions: Record<LeadHandback['stage'], readonly LeadHandback['stage'][]> = {
          prepared: ['running', 'withdrawn'], running: ['awaiting-ci'], 'awaiting-ci': ['completed', 'failed'],
          completed: [], failed: [], withdrawn: [], abandoned: [],
        }
        ensure(transitions[previous.stage].includes(op.stage))
        ensure(previous.publishedHead === null || previous.publishedHead === op.publishedHead)
      }
      const preserveWait = state.phase === 'waiting-for-user' && state.managementReason !== 'lead-result-awaiting-person' && !state.managementReason?.startsWith('lead-repair-')
      const handbacks = [...state.handbacks.filter(item => item.key !== op.key), op]
      const following = op.stage === 'awaiting-ci' || op.stage === 'withdrawn' && !leadRepairResultReady({ ...state, handbacks })
      state = { ...state, handbacks, phase: hasPendingLeadPlan(state) ? 'awaiting-plan' : preserveWait ? state.phase : following ? 'following' : 'running', managementReason: preserveWait ? state.managementReason : null,
        decidedCards: [...new Set([...state.decidedCards, ...state.cards.filter(card => card.type === 'result').map(cardKey)])] }
      break
    }
    case 'ci-passed':
      ensure(state.pr?.state === 'open' && state.pr.branchOwner !== 'person' && state.pr.head === event.head &&
        state.pr.check?.head === event.head && state.pr.check.state === 'passed' && state.pr.check.total > 0 && !state.ciPassed.includes(event.head))
      state = { ...state, ciPassed: [...state.ciPassed, event.head],
        ...(state.handbacks.at(-1) && leadHandbackTerminal(state.handbacks.at(-1)!) && !hasPendingLeadPlan(state) &&
          !(state.phase === 'following' && state.handbacks.at(-1)!.stage === 'completed') &&
          (state.phase !== 'waiting-for-user' || state.managementReason?.startsWith('lead-repair-')) ? { phase: 'running', managementReason: null } : {}) }; break
    case 'new-goal': {
      ensure(canBeginLeadGoal(state) && !state.completedBudgets.some(budget => budget.logicalGoalId === event.id) && state.budget!.logicalGoalId !== event.id)
      const budget = reduceLeadBudget(null, { version: 1, type: 'initialize', now: event.now, logicalGoalId: event.id,
        caps: state.budget!.caps, freshnessMs: state.budget!.freshnessMs })
      state = { ...initialLeadState(), seq: event.seq, goalStartedSeq: event.seq, name: state.name, nameChosen: state.nameChosen, wakes: state.wakes, follow: state.follow, policy: state.policy, budget,
        completedBudgets: [...state.completedBudgets, state.budget!], messages: state.messages, olderMessages: state.olderMessages, sends: state.sends,
        decisionMessages: state.decisionMessages }
      break
    }
    case 'wake': state = { ...state, wakes: [...state.wakes.filter(wake => wake.id !== event.wake.id), event.wake].sort((a, b) => a.at - b.at).slice(-128) }; break
    case 'settings-changed': state = { ...state, ...(event.name === undefined ? {} : { name: event.name, nameChosen: true }), ...(event.follow === undefined ? {} : { follow: event.follow }) }; break
    case 'publication': {
      const op = event.operation, previous = state.publication
      if (op.stage === 'superseded') {
        ensure(previous && ['needs-you', 'push-prepared'].includes(previous.stage) && previous.effectStarted === false && event.pr === null &&
          JSON.stringify({ ...previous, stage: 'superseded' }) === JSON.stringify(op))
        state = { ...state, publication: op }; break
      }
      const card = state.cards.find(card => card.id === op.decision.cardId)
      ensure(card && card.type === 'result' && card.contractDigest === state.contract?.digest && !state.decidedCards.includes(cardKey(card)))
      parseLeadCardDecisionFor(op.decision, card)
      ensure(op.decision.choice === 'accept-open-pr' || card!.type === 'result' && card!.publication === 'push' && op.decision.choice === 'accept')
      ensure(!['accepted', 'declined', 'stopped'].includes(state.phase) && op.source.branch !== op.source.defaultBranch)
      if (!previous || previous.id !== op.id) ensure(op.stage === 'push-prepared' && (!previous || ['completed', 'superseded'].includes(previous.stage)) && event.pr === null)
      else {
        ensure(JSON.stringify({ ...previous, stage: undefined, effectStarted: undefined }) === JSON.stringify({ ...op, stage: undefined, effectStarted: undefined }))
        ensure(op.effectStarted === previous.effectStarted || op.stage === 'push-started' && op.effectStarted === true)
        const allowed: Record<LeadPublicationOperation['stage'], readonly string[]> = { 'push-prepared': ['push-prepared', 'push-started', 'pushed', 'needs-you'], 'push-started': ['push-started', 'pushed', 'needs-you'], superseded: [], pushed: ['create-prepared', 'completed', 'needs-you'],
          'create-prepared': ['completed', 'needs-you'], completed: ['completed'], 'needs-you': ['push-prepared', 'push-started', 'needs-you'] }
        ensure(allowed[previous.stage].includes(op.stage))
      }
      if (op.stage === 'push-started') ensure(op.effectStarted === true)
      if (op.stage === 'completed') ensure(event.pr !== null)
      if (event.pr) {
        ensure(op.stage === 'completed' && event.pr.repository === op.source.repository && event.pr.branch === op.source.branch && event.pr.head === op.source.head)
        ensure(!state.pr || state.pr.repository === event.pr.repository && state.pr.number === event.pr.number && state.pr.branch === event.pr.branch)
      }
      state = { ...state, publication: op, pr: event.pr ?? state.pr,
        ...(op.stage === 'needs-you' ? { phase: 'waiting-for-user' as const, managementReason: 'lead-publication-needs-you' } : {}) }
      break
    }
    case 'owned-push': {
      const op = event.operation, previous = state.ownedPush, pr = state.pr, original = state.publication?.source
      ensure(pr && pr.branchOwner !== 'person' && pr.state === 'open' && op.number === pr.number && op.source.repository === pr.repository && op.source.branch === pr.branch &&
        op.source.branch !== op.source.defaultBranch && !['accepted', 'declined', 'stopped'].includes(state.phase))
      ensure(original && ['repository', 'branch', 'cwd', 'defaultBranch', 'runId', 'teamId'].every(key =>
        original[key as keyof typeof original] === op.source[key as keyof typeof op.source]))
      if (op.stage === 'superseded') {
        ensure(previous && ['needs-you', 'prepared'].includes(previous.stage) && previous.effectStarted === false && JSON.stringify({ ...previous, stage: 'superseded' }) === JSON.stringify(op))
        state = { ...state, ownedPush: op }; break
      }
      if (!previous || previous.source.head !== op.source.head) ensure(op.stage === 'prepared' && op.previousHead === pr!.head && (!previous || ['completed', 'superseded'].includes(previous.stage)))
      else {
        ensure(JSON.stringify({ ...previous, stage: undefined, effectStarted: undefined, at: undefined }) === JSON.stringify({ ...op, stage: undefined, effectStarted: undefined, at: undefined }))
        ensure(op.stage === 'completed' ? op.at >= previous.at : op.at === previous.at)
        ensure(op.effectStarted === previous.effectStarted || op.stage === 'push-started' && op.effectStarted === true)
        const allowed: Record<LeadOwnedPush['stage'], readonly string[]> = { prepared: ['prepared', 'push-started', 'completed', 'needs-you'], 'push-started': ['push-started', 'completed', 'needs-you'],
          'needs-you': ['prepared', 'needs-you'], completed: ['completed'], superseded: [] }
        ensure(allowed[previous.stage].includes(op.stage))
      }
      ensure(op.previousHead === pr!.head || op.stage === 'completed' && op.source.head === pr!.head)
      state = { ...state, ownedPush: op,
        ...(op.stage === 'completed' ? { pr: { ...pr!, head: op.source.head, observedHead: op.source.head, check: null, review: null, at: op.at } } : {}),
        ...(op.stage === 'needs-you' ? { phase: 'waiting-for-user' as const, managementReason: 'lead-publication-needs-you' } : {}) }
      break
    }
    case 'pr-observed': {
      const pr = state.pr, observedHead = event.pr.observedHead ?? event.pr.head
      ensure(pr && event.pr.repository === pr.repository && event.pr.number === pr.number &&
        event.pr.at >= pr.at && (pr.state === 'open' || event.pr.state === pr.state))
      const branchOwner = event.pr.branchOwner ?? (observedHead !== pr!.head ? 'person' : pr!.branchOwner ?? 'lead')
      // Releasing ownership is irreversible through observations. Only a
      // head-bound person decision can reclaim it; PR lifecycle is independent.
      ensure(pr!.branchOwner !== 'person' || branchOwner === 'person')
      const head = branchOwner === 'lead' ? event.pr.head : pr!.head
      const obsolete = new Set(state.cards.filter(card => card.type === 'branch-ownership' &&
        (event.pr.state !== 'open' || branchOwner !== 'person' || card.observedHead !== observedHead)).map(card => card.id))
      if (obsolete.size) state = { ...state, cards: state.cards.filter(card => !obsolete.has(card.id)),
        cardPositions: Object.fromEntries(Object.entries(state.cardPositions).filter(([id]) => !obsolete.has(id))),
        cardRevisions: Object.fromEntries(Object.entries(state.cardRevisions).filter(([id]) => !obsolete.has(id))) }
      state = { ...state, handbacks: branchOwner === 'person' ? state.handbacks.map(op => leadHandbackTerminal(op) ? op : { ...op, stage: 'abandoned' as const }) : state.handbacks,
        pr: { ...event.pr, branch: pr!.branch, head, branchOwner, observedHead,
        check: event.pr.check?.head === observedHead ? event.pr.check : null,
        ...(event.pr.review === undefined ? {} : { review: event.pr.review?.head === observedHead ? event.pr.review : null }) },
        ...(event.pr.state !== 'open' ? { phase: event.pr.state === 'merged' ? 'accepted' as const : 'declined' as const, managementReason: null } :
          branchOwner === 'person' && event.pr.branchChange !== 'fast-forward' &&
            (pr!.branchOwner !== 'person' || observedHead !== (pr!.observedHead ?? pr!.head)) ?
            { phase: 'waiting-for-user' as const, managementReason: 'lead-pr-branch-rewritten' } : {}) }
      break
    }
    case 'message': {
      ensure(event.message.revision === event.seq && event.message.id === `message-${event.seq}`)
      ensure(event.idempotencyKey === null ? event.message.role === 'assistant' : event.message.role === 'user' &&
        !state.sends.some(send => send.key === event.idempotencyKey))
      const all = [...state.messages, event.message], excess = Math.max(0, all.length - 256)
      const thread = windowLeadThread({ version: 1, id: 'lead', revision: state.seq, state: state.phase, project: null,
        messages: all.slice(excess), olderMessages: state.olderMessages + excess, cards: [] }, 131072)
      state = { ...state, messages: thread.messages, olderMessages: thread.olderMessages,
        sends: event.idempotencyKey === null ? state.sends : [...state.sends, { key: event.idempotencyKey, messageId: event.message.id, revision: event.seq }].slice(-LEAD_SEND_RECEIPTS) }
      break
    }
    case 'management':
      ensure(!['stopped', 'accepted', 'declined'].includes(state.phase))
      if (event.phase === 'planning') ensure(state.contract === null && ['draft', 'planning'].includes(state.phase))
      state = { ...state, phase: event.phase, managementReason: event.reason ?? null }; break
    case 'resume':
      ensure(state.phase === 'waiting-for-user' && !state.budget?.stop && !hasPendingLeadPlan(state))
      state = { ...state, phase: state.pr?.state === 'open' ? 'following' : 'running', managementReason: null,
        ownedPush: state.ownedPush?.stage === 'needs-you' ? { ...state.ownedPush, stage: 'prepared' } : state.ownedPush }; break
    case 'renew-plan': {
      ensure(state.consent && state.contract && state.consent.expiresAt <= event.now && !state.budget?.stop &&
        !state.recoveryBlocked && !['stopped', 'accepted', 'declined'].includes(state.phase) && !hasPendingLeadPlan(state) && state.consent.renewalCardRevision === undefined)
      const old = [...state.cards].reverse().find(card => card.type === 'plan' && card.contractDigest === state.contract?.digest &&
        JSON.stringify(card.contract) === JSON.stringify(state.contract) && state.decidedCards.includes(cardKey(card)))
      ensure(old)
      if (event.cardId) ensure(!state.cards.some(card => card.id === event.cardId) && state.cards.length < 64)
      else ensure((state.cardRevisions[old!.id] ?? 0) < 32 && old!.revision < Number.MAX_SAFE_INTEGER)
      const card = { ...old!, id: event.cardId ?? old!.id, revision: event.cardId ? 1 : old!.revision + 1 } as LeadCard
      state = { ...state, phase: 'awaiting-plan', consent: { ...state.consent!, renewalCardRevision: card.revision },
        cards: event.cardId ? [...state.cards, card] : state.cards.map(old => old.id === card.id ? card : old),
        cardPositions: { ...state.cardPositions, [card.id]: state.cardPositions[card.id] ?? event.seq },
        cardRevisions: { ...state.cardRevisions, [card.id]: (state.cardRevisions[card.id] ?? 0) + 1 } }
      break
    }
    case 'retry-result': {
      const card = state.cards.find(card => card.id === event.id && card.revision === event.revision && card.type === 'result')
      ensure(card && card.contractDigest === state.contract?.digest && !state.decidedCards.includes(cardKey(card)))
      state = { ...state, retryResult: { id: event.id, revision: event.revision, digest: card!.contractDigest!, goal: state.budget?.logicalGoalId ?? null } }; break
    }
    case 'restore-result': {
      const card = state.cards.find(card => card.id === event.id && card.revision === event.revision && card.type === 'result')
      ensure(card && card.contractDigest === state.contract?.digest && !['stopped', 'accepted', 'declined'].includes(state.phase))
      state = { ...state, decidedCards: state.decidedCards.filter(key => key !== cardKey(card!)) }; break
    }
    case 'invalidate-results':
      state = { ...state, retryResult: null, decidedCards: [...new Set([...state.decidedCards, ...state.cards.filter(card => card.type === 'result').map(cardKey)])] }; break

    case 'second-look-attempt': case 'second-look-restart': {
      ensure(state.runs.some(run => run.runId === event.runId) && !state.secondLooks.some(look => look.stopKey === event.stopKey) && state.secondLooks.length < 128)
      const budget = event.type === 'second-look-restart' ? reopenLeadBudgetRound(state.budget!, event.runId, event.roundId, event.now) : state.budget
      state = { ...state, budget, secondLooks: [...state.secondLooks, { runId: event.runId, stopKey: event.stopKey, at: event.now }] }; break
    }
    case 'person-caps': {
      ensure(state.budget?.logicalGoalId === event.logicalGoalId && event.now >= state.budget.now)
      const budget = applyLeadBudgetCaps({ ...state.budget!, now: event.now }, event.caps)
      state = { ...state, budget, phase: budget.stop ? 'stopped' : state.phase }; break
    }
    case 'budget': {
      if (['reserve', 'start'].includes(event.event.type)) ensure(!['stopped', 'accepted', 'declined'].includes(state.phase))
      if (event.event.type === 'round' && ['stopped', 'accepted', 'declined'].includes(state.phase)) {
        const roundEvent = event.event
        // Recording an already admitted host round is bookkeeping, not new work.
        ensure(state.budget?.rounds.some(round => round.executionId === roundEvent.executionId &&
          round.roundId === roundEvent.roundId))
      }
      const executionId = event.event.type === 'bind' ? event.event.executionId : null
      const binding = state.runs.find(run => run.runId === executionId)
      if (event.event.type === 'bind') {
        const bind = event.event
        ensure(!binding || binding.teamId === bind.goalId && (!bind.startId || binding.correlationId === bind.startId))
        const attempt = bind.startId ? state.attempts.get(bind.startId) : null
        if (attempt?.phase === 'started') {
          const step = state.steps.find(step => step.id === attempt.stepId)
          ensure(attempt.method === 'flow/start-goal' && attempt.dispatched && step?.state === 'admitted' && step.attemptId === attempt.id)
          const owned = state.runs.find(run => run.correlationId === attempt.correlationId)
          ensure(!owned || owned.runId === bind.executionId && owned.teamId === bind.goalId)
          ensure(!binding || binding.correlationId === attempt.correlationId && binding.teamId === bind.goalId)
          const identity = { correlationId: attempt.correlationId, runId: bind.executionId, teamId: bind.goalId }
          if (!owned) state = { ...state, teams: [...new Set([...state.teams, bind.goalId])], runs: [...state.runs, identity] }
        }
      }
      let budget = reduceLeadBudget(state.budget, binding ? { ...event.event, startId: binding.correlationId } : event.event)
      if (previous.phase === 'stopped' && budget.stop === null) budget = reduceLeadBudget(budget, { version: 1, type: 'stop', now: budget.now, reason: 'cancelled' })
      state = { ...state, budget, phase: budget.stop ? 'stopped' : state.phase }; break
    }
    case 'policy':
      if (state.policy && sameLeadPolicyValues(state.policy, event.policy)) break
      ensure(state.policy === null || event.policy.revision > state.policy.revision &&
        ['narrowing', 'unchanged'].includes(compareLeadPolicyAuthority(state.policy, event.policy)))
      state = { ...state, policy: event.policy }; break
    case 'card': {
      ensure(event.card.type !== 'plan' || state.phase !== 'following')
      const old = state.cards.find(card => card.id === event.card.id)
      ensure(!old || event.card.revision > old.revision && event.card.type === old.type)
      ensure(old || state.cards.length < 64)
      ensure((state.cardRevisions[event.card.id] ?? 0) < 32)
      state = { ...state, cards: old ? state.cards.map(card => card.id === event.card.id ? event.card : card) : [...state.cards, event.card],
        cardPositions: { ...state.cardPositions, [event.card.id]: state.cardPositions[event.card.id] ?? event.seq }, cardRevisions: { ...state.cardRevisions, [event.card.id]: (state.cardRevisions[event.card.id] ?? 0) + 1 } }
      if (event.card.type === 'plan') {
        const replacingRenewal = old?.type === 'plan' && old.contractDigest === state.consent?.contractDigest && old.revision === state.consent?.renewalCardRevision
        const { renewalCardRevision: _, ...consent } = state.consent ?? {}
        state = { ...state, phase: 'awaiting-plan', consent: replacingRenewal ? consent as NonNullable<LeadState['consent']> : state.consent }
      }
      break
    }
    case 'card-decision': {
      if (state.retryResult?.id === event.decision.cardId && state.retryResult.revision === event.decision.expectedRevision) state = { ...state, retryResult: null }
      const card = state.cards.find(card => card.id === event.decision.cardId)
      ensure(card && !state.decidedCards.includes(cardKey(card)))
      const decision = parseLeadCardDecisionFor(event.decision, card)
      if (decision.choice === 'accept-open-pr' || card!.type === 'result' && card!.publication === 'push' && decision.choice === 'accept')
        ensure(state.pr && state.publication?.stage === 'completed' && JSON.stringify(state.publication.decision) === JSON.stringify(decision))
      ensure(card)
      if (card!.type === 'plan') {
        if (decision.choice === 'approve') {
          const renewal = state.consent?.renewalCardRevision === card!.revision && JSON.stringify(state.contract) === JSON.stringify(card!.contract)
          if (!renewal) assertPlanApprovable(state, card!.contract)
          else ensure(event.expiresAt !== null && event.expiresAt > state.consent!.expiresAt)
          ensure(event.expiresAt !== null && event.expiresAt > 0)
          const contract = card!.contract
          const locked = state.steps.filter(step => step.state !== 'pending')
          // A new-goal record resets ownership. Revising a plan within this goal
          // must keep earlier executions, even when its new steps are pending.
          state = { ...state, contract, phase: 'running',
            consent: { contractDigest: card!.contract.digest, contractRevision: card!.contract.revision,
              policyRevision: card!.contract.policyRevision, expiresAt: event.expiresAt! },
            steps: contract.steps.map(step => locked.find(existing => existing.id === step.id) ?? { id: step.id, state: 'pending', attemptId: null, contractDigest: null }),
            decidedCards: [...new Set([...state.decidedCards, ...state.cards.filter(other => other.type === 'plan' && other.id !== card!.id &&
              other.contract.revision <= contract.revision).map(cardKey)])] }
          if (state.budget && !renewal) state = { ...state, budget: applyLeadBudgetCaps(state.budget, contract.caps) }
        } else state = { ...state, phase: state.contract === null ? 'declined' : managementPhase(state) }
      } else if (card!.type === 'branch-ownership') {
        const pr = state.pr
        ensure(pr && pr.state === 'open' && pr.branchOwner === 'person' && card!.contractDigest === state.contract?.digest &&
          card!.repository === pr.repository && card!.number === pr.number && card!.observedHead === pr.observedHead && !['accepted', 'declined', 'stopped'].includes(state.phase))
        if (decision.choice === 'reclaim-branch') {
          const { branchChange: _, releaseReason: __, ...retained } = pr!
          state = { ...state, phase: 'following', managementReason: null, ownedPush: null,
            pr: { ...retained, head: card!.observedHead, branchOwner: 'lead' } }
        } else state = { ...state, phase: 'following', managementReason: null }
      } else if (card!.type === 'budget-change') {
        ensure(state.budget && card!.contractDigest === (state.contract?.digest ?? null))
        state = { ...state, budget: applyLeadBudgetCard(state.budget!, event.decision, card!) }
      } else if (card!.type === 'permission-change') {
        ensure(state.policy)
        state = { ...state, policy: applyLeadPolicyDecision(event.decision, card, state.policy!, state.contract?.digest ?? null) }
      } else {
        ensure(card!.contractDigest === state.contract?.digest)
        state = { ...state, phase: card!.type === 'result' && card!.publication === 'push' && decision.choice === 'decline' ? state.phase : decision.choice === 'decline' ? state.pr ? 'waiting-for-user' : 'declined' : card!.type === 'result' ? state.pr ? 'following' : 'accepted' : 'running',
          ...(decision.choice === 'decline' && state.pr && !(card!.type === 'result' && card!.publication === 'push') ? { managementReason: 'lead-publication-needs-you' } : {}) }
      }
      const decisionMessages = [...state.decisionMessages.filter(message => message.card.id !== card!.id), { card: card!, choice: decision.choice, position: state.cardPositions[card!.id]! }].slice(-64)
      while (new TextEncoder().encode(JSON.stringify(decisionMessages)).byteLength > 131072) decisionMessages.shift()
      state = { ...state, decisionMessages }
      const prune = card!.type === 'permission-change' || card!.type === 'budget-change'
      const cards = prune ? state.cards.filter(other => other.id !== card!.id) : state.cards
      const cardRevisions = { ...state.cardRevisions }, cardPositions = { ...state.cardPositions }
      if (prune) { delete cardRevisions[card!.id]; delete cardPositions[card!.id] }
      const decidedCards = [...state.decidedCards, cardKey(card!)]
      const retained = new Set(cards.map(cardKey))
      const tombstones = new Set(decidedCards.filter(key => !retained.has(key)).slice(-256))
      state = { ...state, cards, cardRevisions, cardPositions, decidedCards: decidedCards.filter(key => retained.has(key) || tombstones.has(key)) }
      break
    }
    case 'team-approved':
      ensure(state.contract?.digest === event.contractDigest && !state.teams.includes(event.teamId) && state.teams.length < 4096)
      state = { ...state, teams: [...state.teams, event.teamId] }; break
    case 'stop': state = { ...state, phase: 'stopped', chatEffectsAcknowledged: true, budget: state.budget ? reduceLeadBudget(state.budget,
      { version: 1, type: 'stop', now: state.budget.now, reason: 'cancelled' }) : null }; break
    case 'stop-effects-done':
      ensure(state.stopEffectsPending === event.stopSeq); state = { ...state, stopEffectsPending: null }; break
    case 'recovery-block': state = { ...state, recoveryBlocked: true }; break
    case 'recovery-resolved': state = { ...state, recoveryBlocked: false }; break
    case 'recovery-report':
      updateAttempt(event.id, attempt => {
        ensure(!attempt.recoveryReported)
        return { ...attempt, recoveryReported: true, ...(canReportLeadChatEffect(state, attempt) ? { resolutionPending: false } : {}) }
      }); break
    case 'attempt': {
      const tier = clientTierFor(event.method, event.action === null ? {} : { action: event.action })
      ensure(event.kind === (tier === 'read' ? 'read' : tier === 'run' ? 'mutation' : 'invalid'))
      ensure(event.id === event.correlationId)
      ensure(!state.attempts.has(event.id) && !state.runs.some(run => run.correlationId === event.id) && !state.budget?.rounds.some(round => round.startId === event.id))
      ensure(event.policyRevision === (state.policy?.revision ?? null) && event.contractRevision === (state.contract?.revision ?? null))
      state = { ...state, attempts: new Map([...state.attempts, [event.id, { id: event.id, correlationId: event.correlationId, method: event.method,
        action: event.action, kind: event.kind, stepId: event.stepId, arguments: event.arguments,
        phase: 'attempted', effect: null, dispatched: false, outcome: null, recoveryReported: false, evidence: null, evidenceSeq: null, resolutionPending: false, contested: false }]]) }; break
    }
    case 'decision':
      updateAttempt(event.id, attempt => { ensure(attempt.phase === 'attempted'); return { ...attempt, phase: 'decided', effect: event.effect } }); break
    case 'dispatch-start': {
      const attempt = state.attempts.get(event.id)
      ensure(attempt?.phase === 'decided' && (!event.dispatched || attempt.effect === 'allow' && attempt.kind !== 'invalid'))
      if (event.dispatched && attempt!.kind === 'mutation' && leadWorkerDispatchBlockedByOpenPr(state)) ensure(isLeadCancellation(attempt!.method, attempt!.action))
      if (event.dispatched && attempt!.kind === 'mutation' && hasPendingLeadPlan(state))
        ensure(isLeadCancellation(attempt!.method, attempt!.action))
      if (event.dispatched && attempt!.method === 'flow/start-goal') {
        const step = state.steps.find(step => step.id === attempt!.stepId)
        ensure(state.phase === 'running' && !hasPendingLeadPlan(state) && step?.state === 'pending' && state.steps.find(step => step.state !== 'started')?.id === step.id)
        if (state.budget) state = { ...state, budget: reduceLeadBudget(state.budget, { version: 1, type: 'start', now: state.budget.now, startId: event.id }) }
        state = { ...state, steps: state.steps.map(step => step.id === attempt!.stepId ? { ...step, state: 'admitted', attemptId: event.id, contractDigest: state.contract!.digest } : step) }
      }
      updateAttempt(event.id, attempt => ({ ...attempt, phase: 'started', dispatched: event.dispatched })); break
    }
    case 'result': {
      const attempt = state.attempts.get(event.id)
      ensure(attempt?.phase === 'started')
      ensure(attempt!.dispatched ? ['succeeded', 'failed', 'uncertain'].includes(event.outcome) : ['denied', 'asked', 'malformed', 'interrupted'].includes(event.outcome))
      ensure(event.identity === null || event.outcome === 'succeeded')
      if (event.outcome === 'succeeded' && attempt!.method === 'flow/start-goal') {
        ensure(event.identity)
        ensure(state.runs.filter(run => run.correlationId === attempt!.correlationId).every(run =>
          run.runId === event.identity!.runId && run.teamId === event.identity!.teamId))
        complete(event.id, event.identity!)
      }
      else ensure(event.identity === null)
      if (event.outcome === 'failed' && attempt!.method === 'flow/start-goal') releaseStart(event.id)
      updateAttempt(event.id, attempt => ({ ...attempt, phase: 'finished', outcome: event.outcome }))
      if (event.outcome === 'uncertain' && isLeadChatEffect(attempt!)) state = { ...state, chatEffectsAcknowledged: false }
      if (event.outcome === 'uncertain' && attempt!.kind !== 'read') state = { ...state, phase: 'waiting-for-user',
        steps: state.steps.map(step => step.attemptId === event.id ? { ...step, state: 'uncertain' } : step) }
      break
    }
    case 'start-resolution': {
      const attempt = state.attempts.get(event.id)
      ensure(attempt?.phase === 'finished' && attempt.method === 'flow/start-goal' && attempt.evidence !== null && attempt.evidenceSeq === event.evidenceSeq)
      const identities = parseLeadRunEvidence(attempt!.evidence).filter(run => !run.terminal)
      ensure(attempt!.resolutionPending)
      if (event.identity === null) {
        ensure(attempt!.outcome === 'uncertain' && identities.length === 0 && !attempt!.contested)
        releaseStart(event.id)
        updateAttempt(event.id, attempt => ({ ...attempt, outcome: 'failed' }))
      } else {
        // Recovery has already admitted this host-proven identity and Team. A
        // window resolution may bind accounting, but cannot manufacture authority.
        // A conflicting lookup leaves the attempt uncertain; the window may confirm the retained run.
        ensure(['succeeded', 'uncertain'].includes(attempt!.outcome!) && identities.length === 1 &&
          identities[0]!.correlationId === event.identity.correlationId && identities[0]!.runId === event.identity.runId && identities[0]!.teamId === event.identity.teamId)
        const priorPlan = state.runs.some(run => !state.steps.some(step => step.attemptId === run.correlationId))
        ensure(event.goalId === event.identity.teamId && (state.budget!.goalId === null || state.budget!.goalId === event.goalId || state.contract!.steps.length > 1 || priorPlan))
        ensure(state.teams.includes(event.identity.teamId) && state.runs.some(run => JSON.stringify(run) === JSON.stringify(event.identity)))
        state = { ...state, budget: reduceLeadBudget(state.budget, { version: 1, type: 'bind', now: state.budget!.now,
          startId: event.id, firstRoundId: identities[0]!.firstRoundId, goalId: event.goalId, executionId: event.identity.runId }) }
        updateAttempt(event.id, attempt => ({ ...attempt, outcome: 'succeeded', contested: false }))
      }
      updateAttempt(event.id, attempt => ({ ...attempt, resolutionPending: false }))
      if (state.managementReason === null && ![...state.attempts.values()].some(attempt => attempt.kind === 'mutation' && attempt.outcome === 'uncertain')) state = { ...state, phase: 'running' }
      break
    }
    case 'reconciliation-conflict':
      updateAttempt(event.id, attempt => {
        // Recovery contests a start before writing its evidence, so it may have none yet.
        ensure(attempt.phase === 'finished' && attempt.kind === 'mutation')
        // A click the window showed before this conflict answers older evidence.
        return { ...attempt, outcome: 'uncertain', resolutionPending: true, evidenceSeq: attempt.evidence === null ? null : event.seq, contested: true }
      })
      state = { ...state, phase: 'waiting-for-user' }; break
    case 'reconciliation': {
      const attempt = state.attempts.get(event.id)
      const identities = parseLeadRunEvidence(event.evidence)
      ensure(attempt?.phase === 'finished' && attempt.kind === 'mutation' && (attempt.outcome === 'uncertain' || attempt.resolutionPending ||
        state.runs.some(run => run.correlationId === attempt.correlationId)))
      ensure(attempt!.evidence !== event.evidence)
      ensure(identities.every(identity => identity.correlationId === attempt!.correlationId &&
        !state.runs.some(run => run.runId === identity.runId && run.correlationId !== identity.correlationId)))
      // A missing lookup row is not a terminal report. The port merges evidence;
      // replay independently refuses a record that would silently drop a live run.
      ensure(state.runs.filter(run => run.correlationId === attempt!.correlationId).every(run => identities.some(identity => identity.runId === run.runId)))
      // A completed start is still the step's run after it settles. Unresolved
      // discoveries keep their live-only index so recovery can release a proven
      // no-run start, but must not erase an already-started step's history.
      const started = attempt!.outcome === 'succeeded' && !attempt!.resolutionPending
      const retained = identities.filter(run => !run.terminal || started && state.runs.some(owned =>
        owned.correlationId === attempt!.correlationId && owned.runId === run.runId && owned.teamId === run.teamId))
      const runs = [...state.runs.filter(run => run.correlationId !== attempt!.correlationId), ...retained.map(run => ({ correlationId: run.correlationId, runId: run.runId, teamId: run.teamId }))]
      let budget = state.budget
      for (const run of identities) if (budget) budget = reduceLeadBudget(budget, { version: 1, type: 'bind', now: budget.now,
        goalId: run.teamId, executionId: run.runId, startId: event.id, firstRoundId: run.firstRoundId })
      const teams = [...new Set([...state.teams, ...identities.map(identity => identity.teamId)])]
      ensure(runs.length <= 64 && teams.length <= 4096)
      // Even ambiguous positive evidence is live work: retain it for cancellation
      // and keep new spending blocked until a fresh host lookup resolves it.
      state = { ...state, runs, teams, budget }
      const resolutionPending = attempt!.resolutionPending || attempt!.outcome === 'uncertain'
      updateAttempt(event.id, attempt => ({ ...attempt, evidence: event.evidence, evidenceSeq: event.seq, resolutionPending }))
      if (event.identity !== null) {
        complete(event.id, event.identity)
        updateAttempt(event.id, attempt => ({ ...attempt, outcome: 'succeeded' }))
        if (state.managementReason === null && ![...state.attempts.values()].some(attempt => attempt.kind === 'mutation' && attempt.outcome === 'uncertain')) state = { ...state, phase: 'running' }
      } else if (resolutionPending) {
        updateAttempt(event.id, attempt => ({ ...attempt, outcome: 'uncertain' }))
        state = { ...state, phase: 'waiting-for-user' }
      }
      break
    }
  }
  // Retain unresolved effects and a bounded recent audit index; durable frames retain the full audit.
  if (state.attempts.size > 64) {
    const attempts = new Map(state.attempts)
    for (const [id, attempt] of attempts) {
      if (attempts.size <= 64) break
      const unbound = state.budget?.rounds.some(round => round.startId === id && round.executionId === null)
      if (!(isLeadChatEffect(attempt) && attempt.outcome === 'uncertain') && !unbound && !attempt.resolutionPending && !state.runs.some(run => run.correlationId === attempt.correlationId) && attempt.phase === 'finished' && (attempt.outcome !== 'uncertain' && attempt.outcome !== 'interrupted' || attempt.recoveryReported)) attempts.delete(id)
    }
    state = { ...state, attempts }
  }
  if (!['stopped', 'accepted', 'declined'].includes(state.phase) &&
    !(state.phase === 'waiting-for-user' && state.managementReason !== null) && hasPendingLeadPlan(state)) state = { ...state, phase: 'awaiting-plan' }
  else if (event.type === 'card-decision' && event.decision.cardType === 'plan' && event.decision.choice === 'approve' &&
    [...state.attempts.values()].some(attempt => attempt.kind === 'mutation' && attempt.outcome === 'uncertain')) state = { ...state, phase: 'waiting-for-user' }
  // A provider/billing stop needs the person even while a plan card remains
  // pending. The pending card still fences mutations independently of phase.
  if (event.type === 'management' && event.phase === 'waiting-for-user') state = { ...state, phase: 'waiting-for-user' }
  // Accepting an already-reviewed result spends nothing. It may finish a stopped
  // thread; the monetary latch continues to prohibit all new work.
  const acceptsResult = previous.phase === 'stopped' && previous.budget?.stop && ['budget', 'rounds'].includes(previous.budget.stop.reason) &&
    event.type === 'card-decision' && event.decision.cardType === 'result' && event.decision.choice === 'accept'
  if (event.type !== 'new-goal' && ['stopped', 'accepted', 'declined'].includes(previous.phase) && !acceptsResult) state = { ...state, phase: previous.phase }
  if (state.budget?.stop && !['accepted', 'declined'].includes(state.phase)) state = { ...state, phase: 'stopped' }
  if (!['stopped', 'accepted', 'declined'].includes(state.phase) && hasUncertainLeadChatEffect(state))
    state = { ...state, phase: 'waiting-for-user', managementReason: 'lead-chat-effect-uncertain' }
  // Discovery is a new cancellation generation, even if an older cleanup is
  // currently running or has already acknowledged the original stop.
  const discovered = state.runs.some(run => !previous.runs.some(old => old.runId === run.runId)) ||
    (state.budget?.executionIds.some(id => !previous.budget?.executionIds.includes(id)) ?? false)
  const stopped = state.budget?.stop || previous.phase === 'stopped'
  if (state.budget?.stop && !previous.budget?.stop || discovered && stopped ||
    event.type === 'stop' && previous.phase !== 'stopped' && !previous.budget?.stop)
    state = { ...state, stopEffectsPending: event.seq }
  if (previous.phase === 'waiting-for-user' && state.phase !== 'waiting-for-user') state = { ...state, managementReason: null }
  if (['stopped', 'accepted', 'declined'].includes(state.phase) && state.consent?.renewalCardRevision !== undefined) {
    state = { ...state, decidedCards: [...new Set([...state.decidedCards, ...state.cards.filter(card => card.type === 'plan' &&
      card.contractDigest === state.consent?.contractDigest && card.revision === state.consent?.renewalCardRevision).map(cardKey)])] }
  }
  const retry = state.retryResult
  if (retry && (retry.goal !== (state.budget?.logicalGoalId ?? null) || retry.digest !== state.contract?.digest ||
    state.decidedCards.includes(`${retry.id}:${retry.revision}`) || !state.cards.some(card => card.id === retry.id && card.revision === retry.revision)))
    state = { ...state, retryResult: null }
  return { ...state, decisionRevision: event.type === 'wake' ? previous.decisionRevision : event.seq }
}
export const replayLeadJournal = (records: readonly LeadJournalRecord[]): LeadState => records.reduce(reduceLeadRecord, initialLeadState())
