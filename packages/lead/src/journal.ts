import {
  CLIENT_METHODS, CLIENT_ACTION_TIERS, LEAD_MANAGEMENT_REASONS, clientTierFor, parseLeadCard, parseLeadCardDecision, parseLeadPermissionPolicy, parseLeadBudgetEvent, parseLeadCaps,
  type LeadCard, type LeadCardDecision, type LeadPermissionPolicy, type LeadBudgetEvent, type LeadBudgetState, type LeadCaps,
} from '@harnessdesk/protocol'
import { decideLeadPermission, type LeadPermissionCall, type LeadPermissionContext, type LeadPermissionDecision, type LeadPermissionRequest } from './permissions.js'
import { prepareLeadJournalData, mergeLeadJournalSecurity, type LeadJournalSecurity } from './journal-security.js'
import type { LeadPersistencePort } from './ports.js'
import { reduceLeadRecord, replayLeadJournal, hasPendingLeadPlan, assertPlanApprovable, type LeadState } from './state.js'
import { leadBudgetProjection, type LeadBudgetLedger } from './budget.js'

export const LEAD_JOURNAL_BYTES = 1_048_576
export interface LeadRunIdentity { readonly correlationId: string; readonly runId: string; readonly teamId: string }
export interface LeadRunObservation extends LeadRunIdentity { readonly firstRoundId: string; readonly terminal: boolean }
export interface LeadArgumentSummary {
  readonly type: string
  readonly size: number
  readonly fields: readonly { readonly name: string; readonly type: string; readonly size: number }[]
}
interface Base { readonly version: 1; readonly seq: number }
export type LeadAttemptOutcome = 'succeeded' | 'failed' | 'denied' | 'asked' | 'malformed' | 'uncertain' | 'interrupted'
export type LeadJournalEvent =
  | { readonly type: 'management'; readonly phase: 'planning' | 'waiting-for-user'; readonly reason?: string | null }
  | { readonly type: 'invalidate-results' | 'resume' }
  | { readonly type: 'restore-result'; readonly id: string; readonly revision: number }
  | { readonly type: 'budget'; readonly event: LeadBudgetEvent }
  | { readonly type: 'policy'; readonly policy: LeadPermissionPolicy }
  | { readonly type: 'card'; readonly card: LeadCard }
  | { readonly type: 'card-decision'; readonly decision: LeadCardDecision; readonly expiresAt: number | null }
  | { readonly type: 'start-resolution'; readonly evidenceSeq: number; readonly id: string; readonly identity: LeadRunIdentity | null; readonly goalId: string | null }
  | { readonly type: 'stop-effects-done'; readonly stopSeq: number }
  | { readonly type: 'stop' | 'recovery-block' | 'recovery-resolved' }
  | { readonly type: 'recovery-report' | 'reconciliation-conflict'; readonly id: string }
  | { readonly type: 'team-approved'; readonly teamId: string; readonly contractDigest: string }
  | { readonly type: 'attempt'; readonly id: string; readonly correlationId: string; readonly method: string; readonly action: string | null;
      readonly arguments: LeadArgumentSummary; readonly kind: 'read' | 'mutation' | 'invalid'; readonly stepId: string | null;
      readonly policyRevision: number | null; readonly projectPolicyRevision: number | null; readonly contractRevision: number | null }
  | { readonly type: 'decision'; readonly id: string; readonly effect: 'allow' | 'ask' | 'deny'; readonly reason: string; readonly rule: LeadPermissionDecision['rule'] }
  | { readonly type: 'dispatch-start'; readonly id: string; readonly dispatched: boolean }
  | { readonly type: 'result'; readonly id: string; readonly outcome: LeadAttemptOutcome; readonly identity: LeadRunIdentity | null }
  | { readonly type: 'reconciliation'; readonly id: string; readonly identity: LeadRunIdentity | null; readonly count: number; readonly evidence: string }
export type LeadJournalRecord = Base & LeadJournalEvent
export interface LeadJournalStorage extends LeadPersistencePort<LeadJournalRecord> { prepare?(value: unknown): LeadJournalRecord; checkpoint?(): LeadState | null; journalSecurity?(): LeadJournalSecurity }
const object = (value: unknown, keys?: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('lead-journal-shape')
  const source = value as Record<string, unknown>
  if (keys && (Object.keys(source).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(source, key)))) throw new Error('lead-journal-fields')
  return source
}
const integer = (value: unknown, min = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error('lead-journal-number')
  return value
}
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:/@-]{1,256}$/.test(value)) throw new Error('lead-journal-id')
  return value
}
const choice = <T extends string>(value: unknown, choices: readonly T[]): T => {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error('lead-journal-choice')
  return value as T
}
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value)
const summaryTypes = ['object', 'array', 'string', 'number', 'boolean', 'null', 'invalid'] as const
const summaryKeys = ['root', 'path', 'cwd', 'session', 'sessionId', 'goal', 'team', 'room', 'run', 'id', 'action', 'vars', 'seats',
  'attended', 'client', 'topics', 'scope', 'kind', 'name', 'source', 'sentence', 'retry', 'continues']
const summaryOf = (value: unknown): { type: string; size: number } => ({
  type: value === null ? 'null' : Array.isArray(value) ? 'array' : summaryTypes.includes(typeof value as 'string') ? typeof value : 'invalid',
  size: Math.min(1_000_000, typeof value === 'string' || Array.isArray(value) ? value.length : 0),
})
/** Values and unknown field names never enter the audit. This intentionally sacrifices
 * argument text rather than trying to recognize every provider's credential spelling. */
export const summarizeLeadArguments = (value: unknown): LeadArgumentSummary => {
  const summary = summaryOf(value)
  const fields = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).filter(([name]) => summaryKeys.includes(name)).slice(0, 32).map(([name, item]) => ({ name, ...summaryOf(item) })) : []
  return { ...summary, fields }
}
const parseSummary = (value: unknown): LeadArgumentSummary => {
  const item = object(value, ['type', 'size', 'fields'])
  if (!Array.isArray(item.fields) || item.fields.length > 32) throw new Error('lead-journal-summary')
  const fields = Array.from(item.fields, field => {
    const entry = object(field, ['name', 'type', 'size'])
    return { name: choice(entry.name, summaryKeys), type: choice(entry.type, summaryTypes), size: integer(entry.size) }
  })
  const summary = { type: choice(item.type, summaryTypes), size: integer(item.size), fields }
  if (summary.size > 1_000_000 || fields.some(field => field.size > 1_000_000)) throw new Error('lead-journal-summary-size')
  return summary
}
export const parseLeadRunIdentity = (value: unknown): LeadRunIdentity => {
  const source = object(value, ['correlationId', 'runId', 'teamId'])
  return { correlationId: identifier(source.correlationId), runId: identifier(source.runId), teamId: identifier(source.teamId) }
}
/** The host lookup's exact identity set is retained for both recovery and window decisions. */
export const parseLeadRunObservation = (value: unknown): LeadRunObservation => {
  const source = object(value, ['correlationId', 'runId', 'teamId', 'firstRoundId', 'terminal'])
  if (typeof source.terminal !== 'boolean') throw new Error('lead-journal-run-terminal')
  return { correlationId: identifier(source.correlationId), runId: identifier(source.runId), teamId: identifier(source.teamId),
    firstRoundId: identifier(source.firstRoundId), terminal: source.terminal }
}
const runIdentity = (source: LeadRunObservation): LeadRunIdentity => ({ correlationId: source.correlationId, runId: source.runId, teamId: source.teamId })
const LEAD_EVIDENCE_ROWS = 64
const sortEvidence = (rows: readonly LeadRunObservation[]) => [...rows].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)
export const parseLeadRunEvidence = (value: unknown): readonly LeadRunObservation[] => {
  if (typeof value !== 'string' || value.length > 131_072) throw new Error('lead-journal-evidence')
  const source: unknown = JSON.parse(value)
  if (!Array.isArray(source) || source.length > LEAD_EVIDENCE_ROWS) throw new Error('lead-journal-evidence')
  const identities = source.map(parseLeadRunObservation)
  if (new Set(identities.map(identity => identity.runId)).size !== identities.length) throw new Error('lead-journal-evidence')
  return identities
}
const safeBytes = (value: unknown): void => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > LEAD_JOURNAL_BYTES) throw new Error('lead-journal-record-limit')
}
/** Load/replay validates stored bytes without applying today's write-time masks. */
export const parseLeadJournalRecord = (value: unknown): LeadJournalRecord => {
  const source = object(value)
  if (source.version !== 1) throw new Error('lead-journal-version')
  const seq = integer(source.seq, 1)
  const keys: Record<string, readonly string[]> = {
    management: ['phase', ...(Object.hasOwn(source, 'reason') ? ['reason'] : [])], 'invalidate-results': [], resume: [], 'restore-result': ['id', 'revision'], budget: ['event'], 'start-resolution': ['id', 'identity', 'goalId', 'evidenceSeq'], 'stop-effects-done': ['stopSeq'],
    policy: ['policy'], card: ['card'], 'card-decision': ['decision', 'expiresAt'], stop: [], 'recovery-block': [], 'recovery-resolved': [], 'recovery-report': ['id'], 'reconciliation-conflict': ['id'], 'team-approved': ['teamId', 'contractDigest'],
    attempt: ['id', 'correlationId', 'method', 'action', 'arguments', 'kind', 'stepId', 'policyRevision', 'projectPolicyRevision', 'contractRevision'],
    decision: ['id', 'effect', 'reason', 'rule'], 'dispatch-start': ['id', 'dispatched'], result: ['id', 'outcome', 'identity'], reconciliation: ['id', 'identity', 'count', 'evidence'],
  }
  const type = choice(source.type, Object.keys(keys))
  object(source, ['version', 'seq', 'type', ...keys[type]!])
  let event: LeadJournalEvent
  switch (type) {
    case 'management': event = { type, phase: choice(source.phase, ['planning', 'waiting-for-user']), ...(Object.hasOwn(source, 'reason') ? { reason: source.reason === null ? null : choice(source.reason, LEAD_MANAGEMENT_REASONS) } : {}) }; break
    case 'invalidate-results': case 'resume': event = { type }; break
    case 'restore-result': event = { type, id: identifier(source.id), revision: integer(source.revision, 1) }; break
    case 'start-resolution': {
      const identity = nullable(source.identity, parseLeadRunIdentity), goalId = nullable(source.goalId, identifier)
      if ((identity === null) !== (goalId === null)) throw new Error('lead-journal-start-resolution')
      event = { type, id: identifier(source.id), identity, goalId, evidenceSeq: integer(source.evidenceSeq, 1) }; break
    }
    case 'stop-effects-done': event = { type, stopSeq: integer(source.stopSeq, 1) }; break
    case 'budget': event = { type, event: parseLeadBudgetEvent(source.event) }; break
    case 'policy': event = { type, policy: parseLeadPermissionPolicy(source.policy) }; break
    case 'card': event = { type, card: parseLeadCard(source.card) }; break
    case 'card-decision': event = { type, decision: parseLeadCardDecision(source.decision), expiresAt: nullable(source.expiresAt, integer) }; break
    case 'stop': case 'recovery-block': case 'recovery-resolved': event = { type }; break
    case 'recovery-report': case 'reconciliation-conflict': event = { type, id: identifier(source.id) }; break
    case 'team-approved':
      if (typeof source.contractDigest !== 'string' || !/^[a-f0-9]{64}$/.test(source.contractDigest)) throw new Error('lead-journal-digest')
      event = { type, teamId: identifier(source.teamId), contractDigest: source.contractDigest }; break
    case 'attempt': {
      const method = identifier(source.method)
      const action = nullable(source.action, value => choice(value, ['abandon', 'done', 'invalid']))
      event = { type, id: identifier(source.id), correlationId: identifier(source.correlationId), method, action,
        arguments: parseSummary(source.arguments), kind: choice(source.kind, ['read', 'mutation', 'invalid']),
        stepId: nullable(source.stepId, identifier), policyRevision: nullable(source.policyRevision, integer), projectPolicyRevision: nullable(source.projectPolicyRevision, integer), contractRevision: nullable(source.contractRevision, integer) }; break
    }
    case 'decision': {
      const rule = source.rule === null ? null : object(source.rule, ['layer', 'id'])
      event = { type, id: identifier(source.id), effect: choice(source.effect, ['allow', 'ask', 'deny']),
      reason: choice(source.reason, ['policy', 'irreversible', 'worker-approval', 'client-surface', 'mode', 'project', 'run', 'scope',
        'policy-interpretation', 'unapproved', 'consent', 'budget', 'start', 'invalid-input', 'recovery', 'terminal']), rule: rule === null ? null : { layer: choice(rule.layer, ['desk', 'project']), id: identifier(rule.id) } }; break
    }
    case 'dispatch-start':
      if (typeof source.dispatched !== 'boolean') throw new Error('lead-journal-dispatch')
      event = { type, id: identifier(source.id), dispatched: source.dispatched }; break
    case 'result': event = { type, id: identifier(source.id), outcome: choice(source.outcome, ['succeeded', 'failed', 'denied', 'asked', 'malformed', 'uncertain', 'interrupted']),
      identity: nullable(source.identity, parseLeadRunIdentity) }; break
    case 'reconciliation': {
      const identities = parseLeadRunEvidence(source.evidence)
      const live = identities.filter(identity => !identity.terminal)
      const identity = nullable(source.identity, parseLeadRunIdentity), count = integer(source.count)
      if (live.length !== count || identities.some(item => item.correlationId !== source.id) ||
        JSON.stringify(identity) !== JSON.stringify(count === 1 ? runIdentity(live[0]!) : null)) throw new Error('lead-journal-match-count')
      event = { type, id: identifier(source.id), identity, count, evidence: source.evidence as string }; break
    }
    default: throw new Error('lead-journal-type')
  }
  const record = { version: 1 as const, seq, ...event }
  safeBytes(record)
  return record
}

export const prepareLeadJournalRecord = (value: unknown, security: LeadJournalSecurity = {}): LeadJournalRecord =>
  parseLeadJournalRecord(prepareLeadJournalData(value, security))

export interface LeadToolAttempt { readonly id: string; readonly request: LeadPermissionRequest; readonly context: LeadPermissionContext; readonly stepId?: string | null }
/** The trusted host may explicitly prove a start created nothing. A thrown or
 * ambiguous response never supplies that proof. */
export type LeadDispatchResult = { readonly value: unknown } & (
  | { readonly identity: LeadRunIdentity | null; readonly created?: never }
  | { readonly identity: null; readonly created: false }
)
export type LeadDispatch = (call: LeadPermissionCall, correlationId: string) => Promise<LeadDispatchResult>
export interface LeadRecoveryAction { readonly id: string; readonly type: 'retry-read' | 'reconciled' | 'needs-user' | 'not-dispatched'; readonly count?: number }
const refusal = (floor: 'start' | 'invalid-input', reason: string): LeadPermissionDecision => ({ effect: 'deny', floor, reason, rule: null, call: null })

export { LEAD_MANAGEMENT_REASONS } from '@harnessdesk/protocol'

/** One serialized management writer. All effects use injected ports; this module owns
 * no files, processes, network, clock or ID generator. IDs come from its trusted owner. */
export class LeadJournal {
  #state: LeadState
  #tail: Promise<unknown> = Promise.resolve()
  #failed = false
  #stopEffectFailure: { readonly reason: 'stop-effects-failed'; readonly stopSeq: number } | null = null
  private readonly security: LeadJournalSecurity
  constructor(private readonly storage: LeadJournalStorage, records: readonly LeadJournalRecord[], security: LeadJournalSecurity = {}, checkpoint: LeadState | null = null) {
    this.security = mergeLeadJournalSecurity(storage.journalSecurity?.() ?? {}, security)
    this.#state = records.reduce(reduceLeadRecord, checkpoint ?? replayLeadJournal([]))
  }
  /** Separate effect report: a durable ledger acknowledgement must not be rejected by cleanup failure. */
  get stopEffectFailure() { return this.#stopEffectFailure && { ...this.#stopEffectFailure } }
  get state(): LeadState { return structuredClone(this.#state) }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(async () => { if (this.#failed) throw new Error('lead-journal-writer-failed'); return operation() })
    this.#tail = next.catch(() => {})
    return next
  }
  #budgetWrite<T>(operation: () => Promise<T>, stopEffects?: () => Promise<void>): Promise<T> {
    return this.#queue(async () => {
      const value = await operation()
      return { value, stop: this.#state.stopEffectsPending !== null }
    }).then(async ({ value, stop }) => {
      // The latch is already durable. Effects run outside the writer queue so they
      // can use its permission-checked cancellation path without deadlocking it.
      if (stop && stopEffects) {
        try { await this.runStopEffects(stopEffects) } catch { /* Reported separately; the ledger write succeeded. */ }
      }
      return value
    })
  }
  async #append(event: LeadJournalEvent): Promise<void> {
    const raw = { version: 1, seq: this.#state.seq + 1, ...event }
    const prepared = prepareLeadJournalRecord(raw, this.security)
    const record = this.storage.prepare ? this.storage.prepare(prepared) : prepared
    // Offer admission is a write-time check. Historical proposals must remain
    // replayable and dismissible even if today's state would refuse to offer them.
    if (record.type === 'card' && record.card.type === 'plan') assertPlanApprovable(this.#state, record.card.contract)
    const next = reduceLeadRecord(this.#state, record)
    try { await this.storage.append(record) }
    catch { this.#failed = true; throw new Error('lead-journal-append-failed') }
    this.#state = next
  }
  setManagementPhase(phase: 'planning' | 'waiting-for-user', reason: string | null = null): Promise<void> { return this.#queue(async () => {
    if (this.#state.phase === phase && this.#state.managementReason === reason) return
    await this.#append({ type: 'management', phase, reason })
  }) }
  resume(): Promise<void> { return this.#queue(() => this.#append({ type: 'resume' })) }
  restoreResult(id: string, revision: number): Promise<void> { return this.#queue(() => this.#append({ type: 'restore-result', id, revision })) }
  /** Call only after acquiring exclusive ownership, before sending any requests. */
  recoverUnsettledRequests(): Promise<void> { return this.#queue(async () => {
    for (const request of this.#state.budget?.requests ?? []) if (!request.uncertain)
      await this.#append({ type: 'budget', event: { version: 1, type: 'uncertain', now: this.#state.budget!.now, requestId: request.reservation.requestId } })
  }) }
  invalidateResults(): Promise<void> { return this.#queue(() => this.#append({ type: 'invalidate-results' })) }
  setPolicy(policy: LeadPermissionPolicy): Promise<void> { return this.#queue(() => this.#append({ type: 'policy', policy })) }
  offerCard(card: LeadCard): Promise<LeadCard> { return this.#queue(async () => { await this.#append({ type: 'card', card }); return structuredClone(this.#state.cards.at(-1)!) }) }
  decideCard(decision: LeadCardDecision, expiresAt: number | null = null, stopEffects?: () => Promise<void>): Promise<void> {
    return this.#budgetWrite(() => this.#append({ type: 'card-decision', decision, expiresAt }), stopEffects)
  }
  /** Caller must await durable admission before sending a paid request or opening a round. */
  updateBudget(event: LeadBudgetEvent, stopEffects?: () => Promise<void>): Promise<LeadBudgetLedger> {
    return this.#budgetWrite(async () => {
      await this.#append({ type: 'budget', event })
      return structuredClone(this.#state.budget!)
    }, stopEffects)
  }
  changeBudgetCaps(value: LeadCaps, card: { id: string; revision: number }, now: number, stopEffects?: () => Promise<void>): Promise<LeadCard | null> {
    return this.#budgetWrite(async () => {
      const caps = parseLeadCaps(value), budget = this.#state.budget
      if (!budget || !Number.isSafeInteger(now) || now < budget.now) throw new Error('lead-budget-refused')
      if (caps.usdMicros <= budget.caps.usdMicros && caps.rounds <= budget.caps.rounds) {
        await this.#append({ type: 'budget', event: { version: 1, type: 'tighten', now, caps } })
        return null
      }
      await this.#append({ type: 'card', card: { version: 1, ...card, type: 'budget-change', logicalGoalId: budget.logicalGoalId,
        contractDigest: this.#state.contract?.digest ?? null, previous: { revision: budget.capsRevision, caps: budget.caps }, proposed: caps } })
      return structuredClone(this.#state.cards.at(-1)!)
    }, stopEffects)
  }
  /** Trusted owner binds a host-resolved Team in the approved project, before any run exists. */
  bindTeam(teamId: string, contractDigest: string): Promise<void> {
    return this.#queue(() => this.#append({ type: 'team-approved', teamId, contractDigest }))
  }
  /** Step 10 must admit recovery-resolved only from the authenticated window, like
   * card decisions. The model loop must never resolve its own quarantine block. */
  resolveRecovery(): Promise<void> { return this.#queue(() => this.#append({ type: 'recovery-resolved' })) }
  /** Only the authenticated window may resolve a needs-user start. Step 10 supplies
   * that click; the model must never attest that its own lost start created nothing. */
  resolveStart(id: string, resolution: { readonly goalId: string; readonly identity: LeadRunIdentity } | null, expectedEvidenceSeq?: number): Promise<void> {
    // Capture the evidence generation when requested, not after a queued lookup.
    // The window can supply the sequence it displayed to reject a stale click.
    const evidenceSeq = expectedEvidenceSeq === undefined ? this.#state.attempts.get(id)?.evidenceSeq : expectedEvidenceSeq
    return this.#queue(async () => {
      const source = resolution === null ? null : object(resolution, ['goalId', 'identity'])
      const goalId = source === null ? null : identifier(source.goalId)
      const identity = source === null ? null : parseLeadRunIdentity(source.identity)
      await this.#append({ type: 'start-resolution', id, goalId, identity, evidenceSeq: integer(evidenceSeq, 1) })
    })
  }
  stop(stopEffects?: () => Promise<void>): Promise<void> { return this.#budgetWrite(() => this.#append({ type: 'stop' }), stopEffects) }
  /** The supervisor retries pending idempotent cancellation after a crash. */
  async runStopEffects(effects: () => Promise<void>): Promise<void> {
    const stopSeq = await this.#queue(async () => this.#state.stopEffectsPending)
    if (stopSeq === null) return
    try {
      await effects()
      await this.#queue(async () => {
        if (this.#state.stopEffectsPending === stopSeq) await this.#append({ type: 'stop-effects-done', stopSeq })
      })
      this.#stopEffectFailure = null
    } catch {
      this.#stopEffectFailure = { reason: 'stop-effects-failed', stopSeq }
      throw new Error('lead-stop-effects-failed')
    }
  }
  execute(input: LeadToolAttempt, dispatch: LeadDispatch): Promise<{ decision: LeadPermissionDecision; outcome: LeadAttemptOutcome; value?: unknown }> {
    const { id, stepId } = input
    return this.#queue(async () => {
      if (this.#state.attempts.has(id) || this.#state.runs.some(run => run.correlationId === id) || this.#state.budget?.rounds.some(round => round.startId === id)) throw new Error('lead-journal-duplicate-attempt')
      let capturedContext: LeadPermissionContext | null
      try { capturedContext = structuredClone(input.context) } catch { capturedContext = null }
      let request: LeadPermissionRequest
      try { request = structuredClone(input.request) } catch { request = { method: 'invalid', params: null, project: null, runId: null, start: null } }
      const raw = request !== null && typeof request === 'object' ? request : { method: 'invalid', params: null }
      const method = typeof raw.method === 'string' && Object.hasOwn(CLIENT_METHODS, raw.method) ? raw.method : 'invalid'
      const params = raw.params !== null && typeof raw.params === 'object' ? raw.params as Record<string, unknown> : {}
      const tier = clientTierFor(method, raw.params)
      const action = Object.hasOwn(CLIENT_ACTION_TIERS, method) && typeof params.action === 'string'
        ? ['abandon', 'done'].includes(params.action) ? params.action : 'invalid' : null
      await this.#append({ type: 'attempt', id, correlationId: id, method, action, arguments: summarizeLeadArguments(raw.params),
        kind: tier === 'read' ? 'read' : tier === 'run' ? 'mutation' : 'invalid', stepId: stepId ?? null,
        policyRevision: this.#state.policy?.revision ?? null, projectPolicyRevision: capturedContext?.projectPolicy?.revision ?? null, contractRevision: this.#state.contract?.revision ?? null })
      const approved = this.#state.contract && this.#state.consent ? { contract: this.#state.contract, consent: this.#state.consent,
        runIds: this.#state.runs.map(run => run.runId), teamIds: this.#state.teams } : null
      let budget: LeadBudgetState | null = null
      try { if (this.#state.budget && capturedContext) {
        budget = leadBudgetProjection(this.#state.budget, capturedContext.now)
        const unbound = this.#state.runs.some(run => !this.#state.budget!.executionIds.includes(run.runId)) ||
          this.#state.steps.some(step => ['admitted', 'uncertain'].includes(step.state) && !this.#state.runs.some(run =>
            run.correlationId === step.attemptId && this.#state.budget!.executionIds.includes(run.runId)))
        if (unbound) budget = { ...budget, spend: 'unknown' }
      } } catch { /* Invalid time cannot manufacture headroom. */ }
      let decision = capturedContext === null ? refusal('invalid-input', 'Invalid permission context')
        : decideLeadPermission(request, { ...capturedContext, budget, now: this.#state.budget ? Math.max(capturedContext.now, this.#state.budget.now) : capturedContext.now,
          desk: this.#state.policy ?? capturedContext.desk, approved })
      const step = this.#state.steps.find(step => step.id === stepId)
      const cancellation = method === 'flow/execution/stop' || method === 'team/intent' && action === 'abandon'
      // Status reads remain available after Stop so the final report can observe desk state.
      if (tier !== 'read' && !cancellation && (['stopped', 'accepted', 'declined'].includes(this.#state.phase) || hasPendingLeadPlan(this.#state) ||
        this.#state.recoveryBlocked || [...this.#state.attempts.values()].some(attempt => attempt.kind === 'mutation' && (attempt.outcome === 'uncertain' || attempt.phase === 'started' && attempt.dispatched))))
        decision = refusal('start', 'Management is stopped pending recovery or user action')
      if (method === 'flow/start-goal' && (!step || step.state !== 'pending' || request.start?.id !== step.id ||
        this.#state.steps.find(step => step.state !== 'started')?.id !== step.id)) decision = refusal('start', 'Step is unapproved, out of order or already admitted')
      await this.#append({ type: 'decision', id, effect: decision.effect, reason: decision.floor ?? 'policy', rule: decision.rule })
      await this.#append({ type: 'dispatch-start', id, dispatched: decision.effect === 'allow' })
      if (decision.effect !== 'allow' || decision.call === null) {
        const outcome = decision.effect === 'ask' ? 'asked' : decision.floor === 'invalid-input' ? 'malformed' : 'denied'
        await this.#append({ type: 'result', id, outcome, identity: null })
        return { decision, outcome }
      }
      let result: LeadDispatchResult
      try { result = await dispatch(decision.call, id) } catch {
        const outcome = tier === 'read' || cancellation ? 'failed' : 'uncertain'
        await this.#append({ type: 'result', id, outcome, identity: null })
        return { decision, outcome }
      }
      if (method === 'flow/start-goal' && result?.created === false && result.identity === null) {
        await this.#append({ type: 'result', id, outcome: 'failed', identity: null })
        return { decision, outcome: 'failed', value: result.value }
      }
      let identity: LeadRunIdentity | null = null
      try { identity = method !== 'flow/start-goal' || result.identity === null ? null : parseLeadRunIdentity(result.identity) } catch { /* An unprovable start is uncertain. */ }
      const outcome = method === 'flow/start-goal' && (identity === null || identity.correlationId !== id) ? 'uncertain' : 'succeeded'
      await this.#append({ type: 'result', id, outcome, identity: outcome === 'succeeded' ? identity : null })
      return { decision, outcome, value: result?.value }
    })
  }
  /** Keeps what replay requires (every tracked run of this start), then live rows
   * while the run index has room, then finished rows, within the evidence bound. */
  #fitEvidence(correlationId: string, rows: readonly LeadRunObservation[]): LeadRunObservation[] {
    const tracked = (run: LeadRunObservation) => this.#state.runs.some(item => item.correlationId === correlationId && item.runId === run.runId)
    const others = this.#state.runs.filter(run => run.correlationId !== correlationId).length
    const ordered = sortEvidence(rows)
    const kept = ordered.filter(tracked)
    const room = Math.max(0, LEAD_EVIDENCE_ROWS - others - kept.filter(run => !run.terminal).length)
    kept.push(...ordered.filter(run => !tracked(run) && !run.terminal).slice(0, room), ...ordered.filter(run => !tracked(run) && run.terminal))
    return kept.slice(0, LEAD_EVIDENCE_ROWS)
  }
  /** Latches an unknown-spend stop once; its record also marks accounting incomplete. */
  async #failClosed(): Promise<void> {
    const budget = this.#state.budget
    if (budget) { if (!budget.accountingIncomplete) await this.#append({ type: 'budget', event: { version: 1, type: 'stop', now: budget.now, reason: 'unknown-spend' } }) }
    else if (this.#state.phase !== 'stopped') await this.#append({ type: 'stop' })
  }
  /** Records what a lookup proved about one start. Any observed row left out of
   * the record (contradicted, foreign, beyond the bound, or beside an omitted
   * tracked run) contests the start before its evidence is written: spend
   * becomes unknown and the window can no longer attest that nothing started. */
  async #record(id: string, rows: readonly LeadRunObservation[], conflict: boolean): Promise<LeadRecoveryAction | null> {
    const attempt = () => this.#state.attempts.get(id)!
    const correlationId = attempt().correlationId
    const known = attempt().evidence === null ? [] : parseLeadRunEvidence(attempt().evidence).map(run => run.runId)
    // A tracked run the lookup omits has not ended, and its row is the proof replay needs.
    const omitted = (fitted: readonly LeadRunObservation[]) => this.#state.runs.some(run => run.correlationId === correlationId && !fitted.some(row => row.runId === run.runId))
    const first = this.#fitEvidence(correlationId, rows)
    const contest = conflict || first.length < rows.length || omitted(first) && rows.some(row => !known.includes(row.runId))
    if (contest) {
      await this.#failClosed()
      if (!attempt().contested) await this.#append({ type: 'reconciliation-conflict', id })
    }
    // Replay needs every tracked run in the next record, so a run that finishing
    // runs make room for is recorded by a second record against the new state.
    let recorded = false
    for (let pass = 0; pass < 2; pass++) {
      const fitted = pass === 0 ? first : this.#fitEvidence(correlationId, rows)
      if (omitted(fitted)) break
      const evidence = JSON.stringify(sortEvidence(fitted))
      if (evidence === attempt().evidence) break
      const live = fitted.filter(run => !run.terminal)
      await this.#append({ type: 'reconciliation', id, identity: live.length === 1 ? runIdentity(live[0]!) : null, count: live.length, evidence })
      recorded = true
      if (fitted.length === rows.length) break
    }
    if (contest) return { id, type: 'needs-user' }
    if (!recorded) return null
    const live = parseLeadRunEvidence(attempt().evidence!).filter(run => !run.terminal)
    return { id, type: live.length === 1 ? 'reconciled' : 'needs-user', count: live.length }
  }
  /** The host lookup must return every non-terminal run carrying this start's
   * correlation, plus explicit terminal observations for runs that have ended.
   * Every identity proves project membership and its first-round id. Omission,
   * paging and lookup failure never prove termination. No recovery path dispatches. */
  recover(reconcile: (attempt: { id: string; correlationId: string; method: string }) => Promise<readonly LeadRunObservation[]>): Promise<readonly LeadRecoveryAction[]> {
    return this.#queue(async () => {
      const actions: LeadRecoveryAction[] = []
      for (const pending of [...this.#state.attempts.values()].filter(attempt => !attempt.recoveryReported && (attempt.phase !== 'finished' || attempt.outcome === 'uncertain' || attempt.resolutionPending || this.#state.runs.some(run => run.correlationId === attempt.correlationId)))) {
        if (pending.phase === 'attempted') await this.#append({ type: 'decision', id: pending.id, effect: 'deny', reason: 'recovery', rule: null })
        if (pending.phase === 'attempted' || pending.phase === 'decided') await this.#append({ type: 'dispatch-start', id: pending.id, dispatched: false })
        if (pending.phase !== 'finished') await this.#append({ type: 'result', id: pending.id,
          outcome: pending.dispatched ? pending.method === 'flow/execution/stop' || pending.method === 'team/intent' && pending.action === 'abandon' ? 'failed' : 'uncertain' : 'interrupted', identity: null })
        if (!pending.dispatched) { await this.#append({ type: 'recovery-report', id: pending.id }); actions.push({ id: pending.id, type: 'not-dispatched' }); continue }
        if (pending.kind === 'read') { await this.#append({ type: 'recovery-report', id: pending.id }); actions.push({ id: pending.id, type: 'retry-read' }); continue }
        if (pending.method === 'flow/execution/stop' || pending.method === 'team/intent' && pending.action === 'abandon') continue
        let observed: readonly LeadRunObservation[] = []
        try {
          observed = (await reconcile({ id: pending.id, correlationId: pending.correlationId, method: pending.method })).map(parseLeadRunObservation)
            .filter(identity => pending.method === 'flow/start-goal' && identity.correlationId === pending.correlationId)
        } catch { /* Failed lookups supply no new evidence. */ continue }
        const retained = new Map((pending.evidence === null ? [] : parseLeadRunEvidence(pending.evidence)).map(run => [run.runId, run]))
        // A run another start owns, or one on another Goal, belongs to no record of this start.
        const foreign = new Set([...this.#state.runs.filter(run => run.correlationId !== pending.correlationId).map(run => run.runId),
          ...[...this.#state.attempts.values()].filter(other => other.id !== pending.id && other.evidence !== null)
            .flatMap(other => parseLeadRunEvidence(other.evidence!).map(run => run.runId))])
        // One record binds one Goal: before any is bound, the first Team in record order is it.
        const goalId = this.#state.budget ? this.#state.budget.goalId
          ?? sortEvidence([...retained.values(), ...observed.filter(run => !foreign.has(run.runId))])[0]?.teamId ?? null : null
        // A row that contradicts retained evidence keeps the retained identity; one
        // that comes back to life stays live so it can be cancelled. Every other row
        // of the same lookup is still recorded.
        let conflict = false
        for (const run of observed) {
          const previous = retained.get(run.runId)
          if (foreign.has(run.runId) || goalId !== null && run.teamId !== goalId) conflict = true
          else if (previous && (previous.teamId !== run.teamId || previous.firstRoundId !== run.firstRoundId || previous.terminal && !run.terminal)) {
            conflict = true
            if (previous.terminal && !run.terminal) retained.set(run.runId, { ...previous, terminal: false })
          } else retained.set(run.runId, run)
        }
        const rows = [...retained.values()]
        try { const action = await this.#record(pending.id, rows, conflict); if (action) actions.push(action) } catch (error) {
          // A record replay refuses must not strand the starts after it. A storage
          // failure has already stopped the writer and is the caller's to see.
          if (this.#failed) throw error
          // Its rows are left out of the record, so the start is contested like any other.
          await this.#failClosed()
          if (!this.#state.attempts.get(pending.id)!.contested) await this.#append({ type: 'reconciliation-conflict', id: pending.id })
          actions.push({ id: pending.id, type: 'needs-user' })
        }
      }
      return actions
    })
  }
}
export const createLeadJournal = async (storage: LeadJournalStorage, security: LeadJournalSecurity = {}): Promise<LeadJournal> => {
  return new LeadJournal(storage, await storage.read(), security, storage.checkpoint?.() ?? null)
}
