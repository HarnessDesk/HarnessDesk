import {
  CLIENT_ACTION_TIERS, clientTierFor, parseLeadCard, parseLeadCardDecision, parseLeadPermissionPolicy,
  type LeadCard, type LeadCardDecision, type LeadPermissionPolicy,
} from '@harnessdesk/protocol'
import { decideLeadPermission, type LeadPermissionCall, type LeadPermissionContext, type LeadPermissionDecision, type LeadPermissionRequest } from './permissions.js'
import type { LeadPersistencePort } from './ports.js'
import { reduceLeadRecord, replayLeadJournal, type LeadState } from './state.js'

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
  | { readonly type: 'policy'; readonly policy: LeadPermissionPolicy }
  | { readonly type: 'card'; readonly card: LeadCard }
  | { readonly type: 'card-decision'; readonly decision: LeadCardDecision; readonly expiresAt: number | null }
  | { readonly type: 'stop' }
  | { readonly type: 'team-approved'; readonly teamId: string; readonly contractDigest: string }
  | { readonly type: 'attempt'; readonly id: string; readonly correlationId: string; readonly method: string; readonly action: string | null;
      readonly arguments: LeadArgumentSummary; readonly kind: 'read' | 'mutation' | 'invalid'; readonly stepId: string | null;
      readonly policyRevision: number | null; readonly projectPolicyRevision: number | null; readonly contractRevision: number | null }
  | { readonly type: 'decision'; readonly id: string; readonly effect: 'allow' | 'ask' | 'deny'; readonly reason: string; readonly rule: LeadPermissionDecision['rule'] }
  | { readonly type: 'dispatch-start'; readonly id: string; readonly dispatched: boolean }
  | { readonly type: 'result'; readonly id: string; readonly outcome: LeadAttemptOutcome; readonly identity: LeadRunIdentity | null }
  | { readonly type: 'reconciliation'; readonly id: string; readonly identity: LeadRunIdentity | null }
export type LeadJournalRecord = Base & LeadJournalEvent
export type LeadJournalStorage = LeadPersistencePort<LeadJournalRecord>
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
/** Defense in depth for non-argument domain data (cards and host identities). Never
 * redact an approval contract silently: its digest would no longer describe the data. */
const safeBytes = (value: unknown): void => {
  const json = JSON.stringify(value)
  if (new TextEncoder().encode(json).byteLength > LEAD_JOURNAL_BYTES ||
    /sk-[A-Za-z0-9_-]{8,}|(?:ghp|github_pat)_[A-Za-z0-9_]{8,}|authorization|bearer\s+[A-Za-z0-9._-]+/i.test(json))
    throw new Error('lead-journal-unsafe-record')
}
export const parseLeadJournalRecord = (value: unknown): LeadJournalRecord => {
  const source = object(value)
  if (source.version !== 1) throw new Error('lead-journal-version')
  const seq = integer(source.seq, 1)
  const keys: Record<string, readonly string[]> = {
    policy: ['policy'], card: ['card'], 'card-decision': ['decision', 'expiresAt'], stop: [], 'team-approved': ['teamId', 'contractDigest'],
    attempt: ['id', 'correlationId', 'method', 'action', 'arguments', 'kind', 'stepId', 'policyRevision', 'projectPolicyRevision', 'contractRevision'],
    decision: ['id', 'effect', 'reason', 'rule'], 'dispatch-start': ['id', 'dispatched'], result: ['id', 'outcome', 'identity'], reconciliation: ['id', 'identity'],
  }
  const type = choice(source.type, Object.keys(keys))
  object(source, ['version', 'seq', 'type', ...keys[type]!])
  let event: LeadJournalEvent
  switch (type) {
    case 'policy': event = { type, policy: parseLeadPermissionPolicy(source.policy) }; break
    case 'card': event = { type, card: parseLeadCard(source.card) }; break
    case 'card-decision': event = { type, decision: parseLeadCardDecision(source.decision), expiresAt: nullable(source.expiresAt, integer) }; break
    case 'stop': event = { type }; break
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
    case 'reconciliation': event = { type, id: identifier(source.id), identity: nullable(source.identity, parseLeadRunIdentity) }; break
    default: throw new Error('lead-journal-type')
  }
  const record = { version: 1 as const, seq, ...event }
  safeBytes(record)
  return record
}

export interface LeadToolAttempt { readonly id: string; readonly request: LeadPermissionRequest; readonly context: LeadPermissionContext; readonly stepId?: string | null }
export interface LeadDispatchResult { readonly value: unknown; readonly identity: LeadRunIdentity | null }
export type LeadDispatch = (call: LeadPermissionCall, correlationId: string) => Promise<LeadDispatchResult>
export interface LeadRecoveryAction { readonly id: string; readonly type: 'retry-read' | 'reconciled' | 'needs-user' | 'not-dispatched' }
const refusal = (floor: 'start' | 'invalid-input', reason: string): LeadPermissionDecision => ({ effect: 'deny', floor, reason, rule: null, call: null })

/** One serialized management writer. All effects use injected ports; this module owns
 * no files, processes, network, clock or ID generator. IDs come from its trusted owner. */
export class LeadJournal {
  #state: LeadState
  #tail: Promise<unknown> = Promise.resolve()
  #failed = false
  constructor(private readonly storage: LeadJournalStorage, records: readonly LeadJournalRecord[]) { this.#state = replayLeadJournal(records) }
  get state(): LeadState { return structuredClone(this.#state) }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(async () => { if (this.#failed) throw new Error('lead-journal-writer-failed'); return operation() })
    this.#tail = next.catch(() => {})
    return next
  }
  async #append(event: LeadJournalEvent): Promise<void> {
    try {
      const record = parseLeadJournalRecord({ version: 1, seq: this.#state.seq + 1, ...event })
      const next = reduceLeadRecord(this.#state, record)
      await this.storage.append(record)
      this.#state = next
    } catch { this.#failed = true; throw new Error('lead-journal-append-failed') }
  }
  setPolicy(policy: LeadPermissionPolicy): Promise<void> { return this.#queue(() => this.#append({ type: 'policy', policy })) }
  offerCard(card: LeadCard): Promise<void> { return this.#queue(() => this.#append({ type: 'card', card })) }
  decideCard(decision: LeadCardDecision, expiresAt: number | null = null): Promise<void> {
    return this.#queue(() => this.#append({ type: 'card-decision', decision, expiresAt }))
  }
  /** Trusted owner binds a host-resolved Team in the approved project, before any run exists. */
  bindTeam(teamId: string, contractDigest: string): Promise<void> {
    return this.#queue(() => this.#append({ type: 'team-approved', teamId, contractDigest }))
  }
  stop(): Promise<void> { return this.#queue(() => this.#append({ type: 'stop' })) }
  execute(input: LeadToolAttempt, dispatch: LeadDispatch): Promise<{ decision: LeadPermissionDecision; outcome: LeadAttemptOutcome; value?: unknown }> {
    return this.#queue(async () => {
      if (this.#state.attempts.some(attempt => attempt.id === input.id)) throw new Error('lead-journal-duplicate-attempt')
      let capturedContext: LeadPermissionContext | null
      try { capturedContext = structuredClone(input.context) } catch { capturedContext = null }
      let request: LeadPermissionRequest
      try { request = structuredClone(input.request) } catch { request = { method: 'invalid', params: null, project: null, runId: null, start: null } }
      const raw = request !== null && typeof request === 'object' ? request : { method: 'invalid', params: null }
      const method = typeof raw.method === 'string' && /^[a-z][a-z0-9-]*\/[a-z0-9/-]{1,200}$/.test(raw.method) &&
        !/sk-|authorization|bearer/i.test(raw.method) ? raw.method : 'invalid'
      const params = raw.params !== null && typeof raw.params === 'object' ? raw.params as Record<string, unknown> : {}
      const tier = clientTierFor(method, raw.params)
      const action = Object.hasOwn(CLIENT_ACTION_TIERS, method) && typeof params.action === 'string'
        ? ['abandon', 'done'].includes(params.action) ? params.action : 'invalid' : null
      await this.#append({ type: 'attempt', id: input.id, correlationId: input.id, method, action, arguments: summarizeLeadArguments(raw.params),
        kind: tier === 'read' ? 'read' : tier === 'run' ? 'mutation' : 'invalid', stepId: input.stepId ?? null,
        policyRevision: this.#state.policy?.revision ?? null, projectPolicyRevision: capturedContext?.projectPolicy?.revision ?? null, contractRevision: this.#state.contract?.revision ?? null })
      const approved = this.#state.contract && this.#state.consent ? { contract: this.#state.contract, consent: this.#state.consent,
        runIds: this.#state.runs.map(run => run.runId), teamIds: this.#state.teams } : null
      let decision = capturedContext === null ? refusal('invalid-input', 'Invalid permission context')
        : decideLeadPermission(request, { ...capturedContext, desk: this.#state.policy ?? capturedContext.desk, approved })
      const step = this.#state.steps.find(step => step.id === input.stepId)
      if (['stopped', 'accepted', 'declined'].includes(this.#state.phase) || tier !== 'read' && this.#state.attempts.some(attempt => attempt.kind === 'mutation' && (attempt.outcome === 'uncertain' || attempt.phase === 'started' && attempt.dispatched)))
        decision = refusal('start', 'Management is stopped pending recovery or user action')
      if (method === 'flow/start-goal' && (!step || step.state !== 'pending' || request.start?.id !== step.id ||
        this.#state.steps.find(step => step.state !== 'completed')?.id !== step.id)) decision = refusal('start', 'Step is unapproved, out of order or already admitted')
      await this.#append({ type: 'decision', id: input.id, effect: decision.effect, reason: decision.floor ?? 'policy', rule: decision.rule })
      await this.#append({ type: 'dispatch-start', id: input.id, dispatched: decision.effect === 'allow' })
      if (decision.effect !== 'allow' || decision.call === null) {
        const outcome = decision.effect === 'ask' ? 'asked' : decision.floor === 'invalid-input' ? 'malformed' : 'denied'
        await this.#append({ type: 'result', id: input.id, outcome, identity: null })
        return { decision, outcome }
      }
      let result: LeadDispatchResult
      try { result = await dispatch(decision.call, input.id) } catch {
        const outcome = tier === 'read' ? 'failed' : 'uncertain'
        await this.#append({ type: 'result', id: input.id, outcome, identity: null })
        return { decision, outcome }
      }
      let identity: LeadRunIdentity | null = null
      try { identity = method !== 'flow/start-goal' || result.identity === null ? null : parseLeadRunIdentity(result.identity) } catch { /* An unprovable start is uncertain. */ }
      const outcome = method === 'flow/start-goal' && (identity === null || identity.correlationId !== input.id) ? 'uncertain' : 'succeeded'
      await this.#append({ type: 'result', id: input.id, outcome, identity: outcome === 'succeeded' ? identity : null })
      return { decision, outcome, value: result?.value }
    })
  }
  /** The injected read-only lookup must prove host-owned correlation and project membership;
   * a matching-looking run name is not proof. No recovery path calls the dispatch port. */
  recover(reconcile: (attempt: { id: string; correlationId: string; method: string }) => Promise<LeadRunIdentity | null>): Promise<readonly LeadRecoveryAction[]> {
    return this.#queue(async () => {
      const actions: LeadRecoveryAction[] = []
      for (const pending of this.#state.attempts.filter(attempt => attempt.phase !== 'finished' || attempt.outcome === 'uncertain')) {
        if (pending.phase === 'attempted') await this.#append({ type: 'decision', id: pending.id, effect: 'deny', reason: 'recovery', rule: null })
        if (pending.phase === 'attempted' || pending.phase === 'decided') await this.#append({ type: 'dispatch-start', id: pending.id, dispatched: false })
        if (pending.phase !== 'finished') await this.#append({ type: 'result', id: pending.id,
          outcome: pending.dispatched ? 'uncertain' : 'interrupted', identity: null })
        if (!pending.dispatched) { actions.push({ id: pending.id, type: 'not-dispatched' }); continue }
        if (pending.kind === 'read') { actions.push({ id: pending.id, type: 'retry-read' }); continue }
        let identity: LeadRunIdentity | null = null
        try {
          const observed = await reconcile({ id: pending.id, correlationId: pending.correlationId, method: pending.method })
          const parsed = observed === null ? null : parseLeadRunIdentity(observed)
          if (pending.method === 'flow/start-goal' && parsed?.correlationId === pending.correlationId) identity = parsed
        } catch { /* Provider/desk errors are never journal payloads or recovery proof. */ }
        await this.#append({ type: 'reconciliation', id: pending.id, identity })
        actions.push({ id: pending.id, type: identity ? 'reconciled' : 'needs-user' })
      }
      return actions
    })
  }
}
export const createLeadJournal = async (storage: LeadJournalStorage): Promise<LeadJournal> => new LeadJournal(storage, await storage.read())
