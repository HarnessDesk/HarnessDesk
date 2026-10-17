import {
  CLIENT_METHODS, CLIENT_ACTION_TIERS, clientTierFor, parseLeadCard, parseLeadCardDecision, parseLeadPermissionPolicy, parseLeadBudgetEvent, parseLeadCaps,
  type LeadCard, type LeadCardDecision, type LeadPermissionPolicy, type LeadBudgetEvent, type LeadBudgetState, type LeadCaps,
} from '@harnessdesk/protocol'
import { decideLeadPermission, type LeadPermissionCall, type LeadPermissionContext, type LeadPermissionDecision, type LeadPermissionRequest } from './permissions.js'
import { prepareLeadJournalData, mergeLeadJournalSecurity, type LeadJournalSecurity } from './journal-security.js'
import type { LeadPersistencePort } from './ports.js'
import { reduceLeadRecord, replayLeadJournal, hasPendingLeadPlan, assertPlanApprovable, type LeadState } from './state.js'
import { leadBudgetProjection, type LeadBudgetLedger } from './budget.js'

export const LEAD_JOURNAL_BYTES = 1_048_576
export interface LeadRunIdentity { readonly correlationId: string; readonly runId: string; readonly teamId: string }
export interface LeadArgumentSummary {
  readonly type: string
  readonly size: number
  readonly fields: readonly { readonly name: string; readonly type: string; readonly size: number }[]
}
interface Base { readonly version: 1; readonly seq: number }
export type LeadAttemptOutcome = 'succeeded' | 'failed' | 'denied' | 'asked' | 'malformed' | 'uncertain' | 'interrupted'
export type LeadJournalEvent =
  | { readonly type: 'budget'; readonly event: LeadBudgetEvent }
  | { readonly type: 'policy'; readonly policy: LeadPermissionPolicy }
  | { readonly type: 'card'; readonly card: LeadCard }
  | { readonly type: 'card-decision'; readonly decision: LeadCardDecision; readonly expiresAt: number | null }
  | { readonly type: 'start-resolution'; readonly id: string; readonly identity: LeadRunIdentity | null; readonly goalId: string | null }
  | { readonly type: 'stop-effects-done'; readonly stopSeq: number }
  | { readonly type: 'stop' | 'recovery-block' | 'recovery-resolved' }
  | { readonly type: 'recovery-report'; readonly id: string }
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
const safeBytes = (value: unknown): void => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > LEAD_JOURNAL_BYTES) throw new Error('lead-journal-record-limit')
}
/** Load/replay validates stored bytes without applying today's write-time masks. */
export const parseLeadJournalRecord = (value: unknown): LeadJournalRecord => {
  const source = object(value)
  if (source.version !== 1) throw new Error('lead-journal-version')
  const seq = integer(source.seq, 1)
  const keys: Record<string, readonly string[]> = {
    budget: ['event'], 'start-resolution': ['id', 'identity', 'goalId'], 'stop-effects-done': ['stopSeq'],
    policy: ['policy'], card: ['card'], 'card-decision': ['decision', 'expiresAt'], stop: [], 'recovery-block': [], 'recovery-resolved': [], 'recovery-report': ['id'], 'team-approved': ['teamId', 'contractDigest'],
    attempt: ['id', 'correlationId', 'method', 'action', 'arguments', 'kind', 'stepId', 'policyRevision', 'projectPolicyRevision', 'contractRevision'],
    decision: ['id', 'effect', 'reason', 'rule'], 'dispatch-start': ['id', 'dispatched'], result: ['id', 'outcome', 'identity'], reconciliation: ['id', 'identity', 'count', 'evidence'],
  }
  const type = choice(source.type, Object.keys(keys))
  object(source, ['version', 'seq', 'type', ...keys[type]!])
  let event: LeadJournalEvent
  switch (type) {
    case 'start-resolution': {
      const identity = nullable(source.identity, parseLeadRunIdentity), goalId = nullable(source.goalId, identifier)
      if ((identity === null) !== (goalId === null)) throw new Error('lead-journal-start-resolution')
      event = { type, id: identifier(source.id), identity, goalId }; break
    }
    case 'stop-effects-done': event = { type, stopSeq: integer(source.stopSeq, 1) }; break
    case 'budget': event = { type, event: parseLeadBudgetEvent(source.event) }; break
    case 'policy': event = { type, policy: parseLeadPermissionPolicy(source.policy) }; break
    case 'card': event = { type, card: parseLeadCard(source.card) }; break
    case 'card-decision': event = { type, decision: parseLeadCardDecision(source.decision), expiresAt: nullable(source.expiresAt, integer) }; break
    case 'stop': case 'recovery-block': case 'recovery-resolved': event = { type }; break
    case 'recovery-report': event = { type, id: identifier(source.id) }; break
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
      if (typeof source.evidence !== 'string' || source.evidence.length > 131_072) throw new Error('lead-journal-evidence')
      const identity = nullable(source.identity, parseLeadRunIdentity), count = integer(source.count)
      if ((identity !== null) !== (count === 1)) throw new Error('lead-journal-match-count')
      event = { type, id: identifier(source.id), identity, count, evidence: source.evidence }; break
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
  resolveStart(id: string, resolution: { readonly goalId: string; readonly identity: LeadRunIdentity } | null): Promise<void> {
    return this.#queue(() => this.#append({ type: 'start-resolution', id, goalId: resolution?.goalId ?? null, identity: resolution?.identity ?? null }))
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
      if (this.#state.attempts.has(id) || this.#state.runs.some(run => run.correlationId === id)) throw new Error('lead-journal-duplicate-attempt')
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
  /** The injected read-only lookup must prove host-owned correlation and project membership;
   * a matching-looking run name is not proof. No recovery path calls the dispatch port. */
  recover(reconcile: (attempt: { id: string; correlationId: string; method: string }) => Promise<readonly LeadRunIdentity[]>): Promise<readonly LeadRecoveryAction[]> {
    return this.#queue(async () => {
      const actions: LeadRecoveryAction[] = []
      for (const pending of [...this.#state.attempts.values()].filter(attempt => !attempt.recoveryReported && (attempt.phase !== 'finished' || attempt.outcome === 'uncertain'))) {
        if (pending.phase === 'attempted') await this.#append({ type: 'decision', id: pending.id, effect: 'deny', reason: 'recovery', rule: null })
        if (pending.phase === 'attempted' || pending.phase === 'decided') await this.#append({ type: 'dispatch-start', id: pending.id, dispatched: false })
        if (pending.phase !== 'finished') await this.#append({ type: 'result', id: pending.id,
          outcome: pending.dispatched ? pending.method === 'flow/execution/stop' || pending.method === 'team/intent' && pending.action === 'abandon' ? 'failed' : 'uncertain' : 'interrupted', identity: null })
        if (!pending.dispatched) { await this.#append({ type: 'recovery-report', id: pending.id }); actions.push({ id: pending.id, type: 'not-dispatched' }); continue }
        if (pending.kind === 'read') { await this.#append({ type: 'recovery-report', id: pending.id }); actions.push({ id: pending.id, type: 'retry-read' }); continue }
        if (pending.method === 'flow/execution/stop' || pending.method === 'team/intent' && pending.action === 'abandon') continue
        let observed: readonly LeadRunIdentity[] = []
        try {
          observed = (await reconcile({ id: pending.id, correlationId: pending.correlationId, method: pending.method })).map(parseLeadRunIdentity)
            .filter(identity => pending.method === 'flow/start-goal' && identity.correlationId === pending.correlationId)
        } catch { /* Failed lookups supply no new evidence. */ continue }
        const evidence = JSON.stringify([...observed].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0))
        if (evidence === pending.evidence) continue
        const identity = observed.length === 1 ? observed[0]! : null
        await this.#append({ type: 'reconciliation', id: pending.id, identity, count: observed.length, evidence })
        actions.push({ id: pending.id, type: identity ? 'reconciled' : 'needs-user', count: observed.length })
      }
      return actions
    })
  }
}
export const createLeadJournal = async (storage: LeadJournalStorage, security: LeadJournalSecurity = {}): Promise<LeadJournal> => new LeadJournal(storage, await storage.read(), security, storage.checkpoint?.() ?? null)
