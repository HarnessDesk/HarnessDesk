import { parseLeadApprovalAudit, parseLeadWorkerApprovalRule, type LeadWorkerApprovalRule } from '@harnessdesk/protocol'
import {
  parseLeadOrigin, parseLeadHandback, parseLeadWakeRecord, type LeadWakeRecord, parseLeadProactive, type LeadProactive, type LeadOrigin, type LeadHandback, parseLeadMessage, parseLeadThreadSend, parseLeadFollowPreferences, parseLeadPullRequest, type LeadFollowPreferences, type LeadPullRequest, type LeadName, type LeadMessage, type LeadSendReceipt,
  CLIENT_METHODS, CLIENT_ACTION_TIERS, LEAD_MANAGEMENT_REASONS, clientTierFor, parseLeadCard, parseLeadCardDecision, parseLeadPermissionPolicy, parseLeadBudgetEvent, parseLeadCaps,
  type LeadCard, type LeadCardDecision, type LeadPermissionPolicy, type LeadBudgetEvent, type LeadBudgetState, type LeadCaps,
} from '@harnessdesk/protocol'
import { compareLeadPolicyAuthority, sameLeadPolicyValues, decideLeadPermission, type LeadPermissionCall, type LeadPermissionContext, type LeadPermissionDecision, type LeadPermissionRequest } from './permissions.js'
import { prepareLeadJournalData, mergeLeadJournalSecurity, type LeadJournalSecurity } from './journal-security.js'
import type { LeadPersistencePort } from './ports.js'
import { isLeadPlanRenewal, hasUncertainLeadChatEffect, isLeadCancellation, canReportLeadChatEffect, leadDecisionRevisionMatches, reduceLeadRecord, replayLeadJournal, fenceLeadWorkerDispatch, hasPendingLeadPlan, leadWorkerDispatchBlockedByOpenPr, assertPlanApprovable, type LeadState } from './state.js'
import { leadBudgetProjection, type LeadBudgetLedger } from './budget.js'

const boolean = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new Error('lead-journal-boolean'); return value }

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
/** Identity frozen from host-owned worker evidence, never model output. */
export interface LeadPublicationSource {
  readonly repository: string; readonly cwd: string; readonly branch: string; readonly head: string
  readonly remote: string; readonly remoteUrl: string; readonly defaultBranch: string
  readonly runId: string; readonly teamId: string; readonly runtime: string; readonly sessionId: string
}
export interface LeadPublicationOperation {
  readonly id: string; readonly decision: LeadCardDecision; readonly source: LeadPublicationSource; readonly at: number
  readonly effectStarted?: boolean
  readonly stage: 'push-prepared' | 'push-started' | 'superseded' | 'pushed' | 'create-prepared' | 'completed' | 'needs-you'
}
export interface LeadOwnedPush {
  readonly source: LeadPublicationSource; readonly number: number; readonly previousHead: string; readonly at: number
  readonly effectStarted?: boolean
  readonly stage: 'prepared' | 'push-started' | 'superseded' | 'completed' | 'needs-you'
}
const effectBoundary = (source: Record<string, unknown>): { readonly effectStarted?: boolean } => {
  if (source.stage === 'push-started' && source.effectStarted !== true || source.stage === 'superseded' && source.effectStarted !== false)
    throw new Error('lead-publication-effect-boundary')
  return source.effectStarted === undefined ? {} : { effectStarted: boolean(source.effectStarted) }
}
export const parseLeadOwnedPush = (value: unknown): LeadOwnedPush => {
  const source = object(value, ['source', 'number', 'previousHead', 'at', 'stage', ...(Object.hasOwn(value as object, 'effectStarted') ? ['effectStarted'] : [])])
  if (typeof source.previousHead !== 'string' || !/^[a-f0-9]{40,64}$/.test(source.previousHead)) throw new Error('lead-owned-push-head')
  return { source: parseLeadPublicationSource(source.source), number: integer(source.number, 1), previousHead: source.previousHead,
    at: integer(source.at), ...effectBoundary(source), stage: choice(source.stage, ['prepared', 'push-started', 'superseded', 'completed', 'needs-you']) }
}
export const parseLeadPublicationSource = (value: unknown): LeadPublicationSource => {
  const source = object(value, ['repository', 'cwd', 'branch', 'head', 'remote', 'remoteUrl', 'defaultBranch', 'runId', 'teamId', 'runtime', 'sessionId'])
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('lead-publication-source')
    if (['branch', 'defaultBranch', 'remote'].includes(key) && (value.startsWith('-') || value.includes('..') || /[~^:?*\[\]\\\s]/.test(value))) throw new Error('lead-publication-branch')
  }
  if (!/^[a-f0-9]{40,64}$/.test(String(source.head)) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(source.repository))) throw new Error('lead-publication-identity')
  return source as unknown as LeadPublicationSource
}
export const parseLeadPublicationOperation = (value: unknown): LeadPublicationOperation => {
  const source = object(value, ['id', 'decision', 'source', 'at', 'stage', ...(Object.hasOwn(value as object, 'effectStarted') ? ['effectStarted'] : [])])
  return { id: identifier(source.id), decision: parseLeadCardDecision(source.decision), source: parseLeadPublicationSource(source.source), at: integer(source.at),
    ...effectBoundary(source), stage: choice(source.stage, ['push-prepared', 'push-started', 'superseded', 'pushed', 'create-prepared', 'completed', 'needs-you']) }
}
export type LeadJournalEvent =
  | { readonly type: 'worker-rule-obsolete'; readonly rule?: LeadWorkerApprovalRule }
  | { readonly type: 'worker-rule-saved'; readonly rule: LeadWorkerApprovalRule }
  | { readonly type: 'worker-rule-dispatch-cancelled'; readonly id: string }
  | { readonly type: 'worker-rule-dispatch'; readonly id: string; readonly diff: string | null }
  | { readonly type: 'worker-rule-used'; readonly id: string; readonly diff?: string | null }
  | { readonly type: 'worker-rule-revoked'; readonly id: string; readonly auditFailed?: true }
  | { readonly type: 'wake'; readonly wake: LeadWakeRecord }
  | { readonly type: 'management'; readonly phase: 'planning' | 'waiting-for-user'; readonly reason?: string | null }
  | { readonly type: 'invalidate-results' | 'resume' }
  | { readonly type: 'new-goal'; readonly id: string; readonly now: number }
  | { readonly type: 'settings-changed'; readonly name?: LeadName; readonly follow?: LeadFollowPreferences }
  | { readonly type: 'publication'; readonly operation: LeadPublicationOperation; readonly pr: LeadPullRequest | null }
  | { readonly type: 'pr-observed'; readonly pr: LeadPullRequest }
  | { readonly type: 'owned-push'; readonly operation: LeadOwnedPush }
  | { readonly type: 'handback'; readonly operation: LeadHandback }
  | { readonly type: 'handback-limit' }
  | { readonly type: 'ci-passed'; readonly head: string }
  | { readonly type: 'origin'; readonly origin: LeadOrigin; readonly key?: string }
  | { readonly type: 'message'; readonly idempotencyKey: string | null; readonly message: LeadMessage }
  | { readonly type: 'renew-plan'; readonly now: number; readonly cardId?: string }
  | { readonly type: 'restore-result' | 'retry-result'; readonly id: string; readonly revision: number }
  | { readonly type: 'second-look-attempt'; readonly runId: string; readonly stopKey: string; readonly now: number }
  | { readonly type: 'second-look-restart'; readonly runId: string; readonly stopKey: string; readonly roundId: string; readonly now: number }
  | { readonly type: 'person-caps'; readonly logicalGoalId: string; readonly caps: LeadCaps; readonly now: number }
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
export interface LeadJournalStorage extends LeadPersistencePort<LeadJournalRecord> { prepare?(value: unknown, previous?: LeadState): LeadJournalRecord; checkpoint?(): LeadState | null; journalSecurity?(): LeadJournalSecurity }
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
    'worker-rule-dispatch-cancelled': ['id'], 'worker-rule-dispatch': ['id', 'diff'], 'worker-rule-obsolete': Object.hasOwn(source, 'rule') ? ['rule'] : [], 'worker-rule-saved': ['rule'], 'worker-rule-used': ['id', ...(Object.hasOwn(source, 'diff') ? ['diff'] : [])], 'worker-rule-revoked': ['id', ...(Object.hasOwn(source, 'auditFailed') ? ['auditFailed'] : [])], wake: ['wake'], 'handback': ['operation'], 'handback-limit': [], 'ci-passed': ['head'], origin: ['origin', ...(Object.hasOwn(source, 'key') ? ['key'] : [])], 'new-goal': ['id', 'now'],
    'renew-plan': ['now', ...(Object.hasOwn(source, 'cardId') ? ['cardId'] : [])], management: ['phase', ...(Object.hasOwn(source, 'reason') ? ['reason'] : [])], 'invalidate-results': [], resume: [], 'settings-changed': ['name', 'follow'].filter(key => Object.hasOwn(source, key)), publication: ['operation', 'pr'], 'pr-observed': ['pr'], 'owned-push': ['operation'], message: ['idempotencyKey', 'message'], 'restore-result': ['id', 'revision'], 'retry-result': ['id', 'revision'], budget: ['event'], 'start-resolution': ['id', 'identity', 'goalId', 'evidenceSeq'], 'stop-effects-done': ['stopSeq'],
    'second-look-attempt': ['runId', 'stopKey', 'now'], 'second-look-restart': ['runId', 'stopKey', 'roundId', 'now'],
    'person-caps': ['logicalGoalId', 'caps', 'now'], policy: ['policy'], card: ['card'], 'card-decision': ['decision', 'expiresAt'], stop: [], 'recovery-block': [], 'recovery-resolved': [], 'recovery-report': ['id'], 'reconciliation-conflict': ['id'], 'team-approved': ['teamId', 'contractDigest'],
    attempt: ['id', 'correlationId', 'method', 'action', 'arguments', 'kind', 'stepId', 'policyRevision', 'projectPolicyRevision', 'contractRevision'],
    decision: ['id', 'effect', 'reason', 'rule'], 'dispatch-start': ['id', 'dispatched'], result: ['id', 'outcome', 'identity'], reconciliation: ['id', 'identity', 'count', 'evidence'],
  }
  const type = choice(source.type, Object.keys(keys))
  object(source, ['version', 'seq', 'type', ...keys[type]!])
  let event: LeadJournalEvent
  switch (type) {
    case 'worker-rule-obsolete': event = { type, ...(Object.hasOwn(source, 'rule') ? { rule: parseLeadWorkerApprovalRule(source.rule, true) } : {}) }; break
    case 'worker-rule-saved':
      try { event = { type, rule: parseLeadWorkerApprovalRule(source.rule) } }
      catch (error) { if ((error as Error).message !== 'lead-worker-approval-obsolete') throw error; event = { type: 'worker-rule-obsolete', ...((source.rule as { key?: { kind?: string } })?.key?.kind === 'fileChange' ? { rule: parseLeadWorkerApprovalRule(source.rule, true) } : {}) } }
      break
    case 'worker-rule-dispatch-cancelled': event = { type, id: identifier(source.id) }; break
    case 'worker-rule-dispatch': event = { type, id: identifier(source.id), diff: source.diff === null ? null : parseLeadApprovalAudit({ ruleId: identifier(source.id), target: 'audit', diff: source.diff }).diff! }; break
    case 'worker-rule-used': event = { type, id: identifier(source.id), ...(Object.hasOwn(source, 'diff') ? { diff: source.diff === null ? null : parseLeadApprovalAudit({ ruleId: identifier(source.id), target: 'audit', diff: source.diff }).diff! } : {}) }; break
    case 'worker-rule-revoked':
      if (Object.hasOwn(source, 'auditFailed') && source.auditFailed !== true) throw new Error('lead-journal-record')
      event = { type, id: identifier(source.id), ...(source.auditFailed === true ? { auditFailed: true } : {}) }; break
    case 'wake': event = { type, wake: parseLeadWakeRecord(source.wake) }; break
    case 'handback': event = { type, operation: parseLeadHandback(source.operation) }; break
    case 'handback-limit': event = { type }; break
    case 'ci-passed': event = { type, head: identifier(source.head) }; break
    case 'origin': event = { type, origin: parseLeadOrigin(source.origin), ...(Object.hasOwn(source, 'key') ? { key: identifier(source.key) } : {}) }; break
    case 'new-goal': event = { type, id: identifier(source.id), now: integer(source.now, 0) }; break
    case 'management': event = { type, phase: choice(source.phase, ['planning', 'waiting-for-user']), ...(Object.hasOwn(source, 'reason') ? { reason: source.reason === null ? null : choice(source.reason, LEAD_MANAGEMENT_REASONS) } : {}) }; break
    case 'message': event = { type, idempotencyKey: nullable(source.idempotencyKey, identifier), message: parseLeadMessage(source.message) }; break
    case 'settings-changed': event = { type, ...(Object.hasOwn(source, 'name') ? { name: choice(source.name, ['dex', 'lex'] as const) } : {}), ...(Object.hasOwn(source, 'follow') ? { follow: parseLeadFollowPreferences(source.follow) } : {}) }; break
    case 'publication': event = { type, operation: parseLeadPublicationOperation(source.operation), pr: nullable(source.pr, parseLeadPullRequest) }; break
    case 'owned-push': event = { type, operation: parseLeadOwnedPush(source.operation) }; break
    case 'pr-observed': event = { type, pr: parseLeadPullRequest(source.pr) }; break
    case 'invalidate-results': case 'resume': event = { type }; break
    case 'renew-plan': event = { type, now: integer(source.now, 0), ...(Object.hasOwn(source, 'cardId') ? { cardId: identifier(source.cardId) } : {}) }; break
    case 'retry-result': case 'restore-result': event = { type, id: identifier(source.id), revision: integer(source.revision, 1) }; break
    case 'start-resolution': {
      const identity = nullable(source.identity, parseLeadRunIdentity), goalId = nullable(source.goalId, identifier)
      if ((identity === null) !== (goalId === null)) throw new Error('lead-journal-start-resolution')
      event = { type, id: identifier(source.id), identity, goalId, evidenceSeq: integer(source.evidenceSeq, 1) }; break
    }
    case 'stop-effects-done': event = { type, stopSeq: integer(source.stopSeq, 1) }; break
    case 'second-look-attempt': event = { type, runId: identifier(source.runId), stopKey: identifier(source.stopKey), now: integer(source.now) }; break
    case 'second-look-restart': event = { type, runId: identifier(source.runId), stopKey: identifier(source.stopKey), roundId: identifier(source.roundId), now: integer(source.now) }; break
    case 'person-caps': event = { type, logicalGoalId: identifier(source.logicalGoalId), caps: parseLeadCaps(source.caps), now: integer(source.now) }; break
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

export interface LeadToolAttempt { readonly id: string; readonly request: LeadPermissionRequest; readonly context: LeadPermissionContext; readonly stepId?: string | null; readonly predecessor?: { readonly runId: string; readonly ready: boolean; readonly terminal?: true; readonly reason?: 'lead-predecessor-unavailable' | 'lead-predecessor-unverifiable' } }
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
  #childLive = false
  #recovering = 0
  /** Host supervisor owns this latch; never expose it in the child journal port. */
  setChildLive(live: boolean): void {
    if (live && this.#recovering > 0) throw new Error('lead-recovery-active')
    this.#childLive = live
  }
  readonly #listeners = new Set<() => void>()
  /** Durable changes only. Observers schedule host work outside the journal queue. */
  onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  #state: LeadState
  #tail: Promise<unknown> = Promise.resolve()
  #failed = false
  readonly #dispatchNotStarted = new Set<string>()
  /**
   * Result cards an invalidation took back while no one had decided them, by
   * `id:revision`. Memory only: after a restart a click on one is refused as
   * before. Never holds a card a person decided.
   */
  readonly #withdrawn = new Set<string>()
  #stopEffectFailure: { readonly reason: 'stop-effects-failed'; readonly stopSeq: number } | null = null
  private readonly security: LeadJournalSecurity
  constructor(private readonly storage: LeadJournalStorage, records: readonly LeadJournalRecord[], security: LeadJournalSecurity = {}, checkpoint: LeadState | null = null) {
    this.security = mergeLeadJournalSecurity(storage.journalSecurity?.() ?? {}, security)
    this.#state = fenceLeadWorkerDispatch(records.reduce(reduceLeadRecord, checkpoint ?? replayLeadJournal([])))
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
      await this.#allowanceWarning()
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
  async #allowanceWarning(): Promise<void> {
    const state = this.#state, ledger = state.budget
    if (!ledger || state.cards.length >= 64) return
    const budget = leadBudgetProjection(ledger, ledger.now), spent = budget.leadUsdMicros + budget.workerUsdMicros
    if (budget.spend !== 'known' || !budget.caps.usdMicros || spent * 5 < budget.caps.usdMicros * 4 ||
      state.cards.some(card => card.type === 'allowance-warning' && card.logicalGoalId === ledger.logicalGoalId && card.caps.usdMicros >= budget.caps.usdMicros)) return
    await this.#append({ type: 'card', card: { version: 1, id: `allowance-${ledger.logicalGoalId}-${budget.caps.usdMicros}`, revision: 1,
      type: 'allowance-warning', contractDigest: state.contract?.digest ?? null, logicalGoalId: ledger.logicalGoalId, usdMicros: spent, caps: budget.caps } })
  }
  /** Host-only claim before an effect, including failed attempts. Never exposed
   * on the child journal port; repeated observation cannot buy a second try. */
  secondLookAttempt(runId: string, stopKey: string, now: number): Promise<void> {
    return this.#queue(() => this.#append({ type: 'second-look-attempt', runId, stopKey, now }))
  }
  reopenSecondLook(runId: string, stopKey: string, roundId: string, now: number): Promise<void> {
    return this.#queue(() => this.#append({ type: 'second-look-restart', runId, stopKey, roundId, now }))
  }
  /** Authenticated person only. The child journal port deliberately has no such operation. */
  raiseBudget(logicalGoalId: string, caps: LeadCaps, expectedRevision: number, now: number): Promise<void> {
    return this.#budgetWrite(async () => {
      this.#expectRevision(expectedRevision)
      const budget = this.#state.budget
      if (['accepted', 'declined'].includes(this.#state.phase) || budget && budget.logicalGoalId !== logicalGoalId)
        throw Object.assign(new Error('lead-thread-closed'), { wireCode: 'lead-thread-closed' })
      if (!budget || budget.logicalGoalId !== logicalGoalId || caps.usdMicros < budget.caps.usdMicros || caps.rounds < budget.caps.rounds ||
        caps.usdMicros === budget.caps.usdMicros && caps.rounds === budget.caps.rounds) throw new Error('lead-budget-refused')
      await this.#append({ type: 'person-caps', logicalGoalId, caps: parseLeadCaps(caps), now })
    })
  }
  async #append(event: LeadJournalEvent, committed?: () => void): Promise<void> {
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
    // A withdrawn card offered again is no longer withdrawn: a later decision on it is a person's.
    for (const key of this.#withdrawn) if (!next.decidedCards.includes(key)) this.#withdrawn.delete(key)
    // The window marks paid work pending at this durable boundary, before projections observe it.
    committed?.()
    for (const listener of this.#listeners) { try { listener() } catch { /* Observers cannot undo a durable write. */ } }
  }
  setManagementPhase(phase: 'planning' | 'waiting-for-user', reason: string | null = null): Promise<void> { return this.#queue(async () => {
    // A child refresh may finish after the person's publication decision.
    // That old acceptance wait cannot take passive following back over.
    if (reason === 'lead-result-awaiting-person' && this.#state.phase === 'following') return
    if (hasUncertainLeadChatEffect(this.#state) && !['stopped', 'accepted', 'declined'].includes(this.#state.phase)) { phase = 'waiting-for-user'; reason = 'lead-chat-effect-uncertain' }
    const fenced = fenceLeadWorkerDispatch(this.#state)
    if (!['stopped', 'accepted', 'declined'].includes(fenced.phase) && fenced.managementReason === 'lead-worker-audit-failed') { phase = 'waiting-for-user'; reason = fenced.managementReason }
    if (this.#state.phase === phase && this.#state.managementReason === reason) return
    await this.#append({ type: 'management', phase, reason })
  }) }
  resume(expectedRevision?: number, unanswered = false, committed?: () => void): Promise<void> { return this.#queue(async () => {
    this.#expectRevision(expectedRevision)
    if (this.#state.cards.some(card => card.type === 'plan' && !this.#state.decidedCards.includes(`${card.id}:${card.revision}`)))
      throw Object.assign(new Error('lead-plan-pending'), { wireCode: 'lead-plan-pending' })
    if (unanswered && this.#state.messages.findLast(message => message.role === 'user' || message.role === 'assistant')?.role === 'user' && !['accepted', 'declined', 'stopped', 'waiting-for-user'].includes(this.#state.phase))
      await this.#append({ type: 'management', phase: 'waiting-for-user', reason: 'lead-request-failed' })
    if (this.#state.workerApprovals.some(rule => rule.dispatch) || this.#state.phase !== 'waiting-for-user' || this.#state.budget?.stop || this.#state.recoveryBlocked)
      throw Object.assign(new Error('lead-no-person-wait'), { wireCode: 'lead-no-person-wait' })
    return this.#append({ type: 'resume' }, committed)
  }) }
  #expectRevision(expected?: number): void {
    if (expected !== undefined && !leadDecisionRevisionMatches(this.#state, expected)) throw Object.assign(new Error('lead-revision-stale'), { wireCode: 'lead-revision-stale' })
  }
  recordWake(wake: LeadWakeRecord): Promise<void> { return this.#queue(async () => {
    const parsed = parseLeadWakeRecord(wake), previous = this.#state.wakes.find(one => one.id === parsed.id)
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(parsed)) throw new Error('lead-wake-already-recorded')
      return
    }
    return this.#append({ type: 'wake', wake: parsed })
  }) }
  settingsChanged(name?: LeadName, follow?: LeadFollowPreferences): Promise<void> { return this.#queue(() => this.#append({ type: 'settings-changed', ...(name === undefined ? {} : { name }), ...(follow === undefined ? {} : { follow }) })) }
  publication(operation: LeadPublicationOperation, pr: LeadPullRequest | null = null): Promise<void> { return this.#queue(() => this.#append({ type: 'publication', operation, pr })) }
  /** Host-only exit after an external publication succeeded but its final
   * person-gate answer refused. The child cannot release this decision fence. */
  publicationNeedsYou(id: string): Promise<void> { return this.#queue(async () => {
    const op = this.#state.publication
    if (!op || op.id !== id || op.stage !== 'completed' || ['accepted', 'declined', 'stopped', 'following'].includes(this.#state.phase)) return
    const card = this.#state.cards.find(card => card.id === op.decision.cardId)
    if (!card || card.revision !== op.decision.expectedRevision || card.contractDigest !== op.decision.contractDigest || this.#state.decidedCards.includes(`${card.id}:${card.revision}`)) return
    await this.#append({ type: 'invalidate-results' })
    await this.#append({ type: 'management', phase: 'waiting-for-user', reason: 'lead-publication-needs-you' })
  }) }
  handback(operation: LeadHandback): Promise<void> { return this.#queue(() => this.#append({ type: 'handback', operation })) }
  handbackLimit(): Promise<void> { return this.#queue(async () => { if (!this.#state.handbackLimit) await this.#append({ type: 'handback-limit' }) }) }
  ciPassed(head: string): Promise<void> { return this.#queue(async () => { if (!this.#state.ciPassed.includes(head)) await this.#append({ type: 'ci-passed', head }) }) }
  setOrigin(origin: LeadOrigin, key?: string): Promise<void> { return this.#queue(() => this.#append({ type: 'origin', origin, ...(key ? { key } : {}) })) }
  ownedPush(operation: LeadOwnedPush): Promise<void> { return this.#queue(() => this.#append({ type: 'owned-push', operation })) }
  observePr(pr: LeadPullRequest): Promise<void> { return this.#queue(() => this.#append({ type: 'pr-observed', pr })) }
  appendMessage(idempotencyKey: string, text: string, committed?: () => void): Promise<LeadSendReceipt> {
    const input = parseLeadThreadSend({ idempotencyKey, text })
    return this.#queue(async () => {
      const previous = this.#state.sends.find(send => send.key === input.idempotencyKey)
      if (previous) return { messageId: previous.messageId, revision: previous.revision }
      const revision = this.#state.seq + 1, messageId = `message-${revision}`
      await this.#append({ type: 'message', idempotencyKey: input.idempotencyKey,
        message: { version: 1, id: messageId, revision, role: 'user', text: input.text } }, committed)
      return { messageId, revision }
    })
  }
  /** Host person capability only; absent from the child persistence port. */
  saveWorkerApproval(rule: LeadWorkerApprovalRule, guard: () => boolean = () => true, answer?: () => Promise<unknown>): Promise<void> { return this.#queue(async () => {
    if (!guard()) throw Object.assign(new Error('lead-card-stale'), { wireCode: 'lead-card-stale' })
    await this.#append({ type: 'worker-rule-saved', rule })
    await answer?.()
  }) }
  revokeWorkerApproval(id: string, contractDigest: string): Promise<void> { return this.#queue(async () => {
    if (this.#state.contract?.digest !== contractDigest) throw Object.assign(new Error('lead-card-stale'), { wireCode: 'lead-card-stale' })
    if (!this.#state.workerApprovals.some(rule => rule.id === id && !rule.revoked)) throw Object.assign(new Error('Saved approval is not active.'), { wireCode: 'lead-approval-not-live' })
    await this.#append({ type: 'worker-rule-revoked', id, ...(this.#state.managementReason === 'lead-worker-audit-failed' || this.#state.workerApprovals.some(rule => rule.dispatch) ? { auditFailed: true as const } : {}) })
  }) }
  useWorkerApproval(id: string, guard: () => boolean, answer: () => Promise<unknown>, diff: string | null = null): Promise<boolean> { return this.#queue(async () => {
    if (!guard() || this.#state.managementReason === 'lead-worker-audit-failed' || this.#state.workerApprovals.some(rule => rule.dispatch) || !this.#state.workerApprovals.some(rule => rule.id === id && !rule.revoked) || ['accepted', 'declined', 'stopped', 'following'].includes(this.#state.phase)) return false
    // Persist the exact request before dispatch. An unacknowledged intent remains a recovery fence.
    await this.#append({ type: 'worker-rule-dispatch', id, diff })
    let called = false
    try {
      if (!guard()) throw Object.assign(new Error('lead-card-stale'), { wireCode: 'lead-card-stale' })
      called = true
      await answer()
    } catch (error) {
      try {
        if (!called || error && typeof error === 'object' && 'approvalNotDelivered' in error && error.approvalNotDelivered === true)
          await this.#append({ type: 'worker-rule-dispatch-cancelled', id })
        else await this.#append({ type: 'management', phase: 'waiting-for-user', reason: 'lead-worker-audit-failed' })
      } finally {
        this.#state = fenceLeadWorkerDispatch(this.#state)
        for (const listener of this.#listeners) { try { listener() } catch { /* Keep the error observable. */ } }
      }
      throw error
    }
    try { await this.#append({ type: 'worker-rule-used', id, diff }) }
    catch (error) {
      // The writer is latched failed; publish a visible in-process stop even when disk cannot record it.
      this.#failed = true
      this.#state = fenceLeadWorkerDispatch(this.#state)
      for (const listener of this.#listeners) { try { listener() } catch { /* Keep the error observable. */ } }
      throw error
    }
    return true
  }) }
  appendReply(text: string, proactive?: LeadProactive): Promise<void> { return this.#queue(() => {
    const revision = this.#state.seq + 1
    return this.#append({ type: 'message', idempotencyKey: null,
      message: { version: 1, id: `message-${revision}`, revision, role: 'assistant', text, ...(proactive ? { proactive: parseLeadProactive(proactive) } : {}) } })
  }) }
  #policyChange(state: LeadState, policy: LeadPermissionPolicy, id: string): LeadJournalEvent | null {
    if (!state.policy) throw new Error('lead-policy-unavailable')
    const comparison = compareLeadPolicyAuthority(state.policy, policy)
    if (sameLeadPolicyValues(state.policy, policy)) return null
    if (comparison === 'narrowing' || comparison === 'unchanged') return { type: 'policy', policy }
    if (state.cards.some(card => card.type === 'permission-change' && !state.decidedCards.includes(`${card.id}:${card.revision}`)))
      throw Object.assign(new Error('lead-change-pending'), { wireCode: 'lead-change-pending' })
    return { type: 'card', card: { version: 1, id, revision: 1, type: 'permission-change',
      contractDigest: state.contract?.digest ?? null, previous: state.policy, proposed: policy } }
  }
  changePolicy(policy: LeadPermissionPolicy, expectedRevision: number, id: string, admit?: (card: LeadCard) => void): Promise<void> { return this.#queue(async () => {
    this.#expectRevision(expectedRevision)
    const event = this.#policyChange(this.#state, policy, id)
    if (!event) return
    if (event.type === 'card') admit?.(event.card)
    await this.#append(event)
  }) }
  /** Preflight both authority changes on the writer queue before appending either. */
  changePolicyAndBudgetCaps(policy: LeadPermissionPolicy, caps: LeadCaps, expectedRevision: number,
    ids: { readonly policy: string; readonly caps: string }, now: number, stopEffects?: () => Promise<void>,
    admit?: (state: LeadState, card: LeadCard) => void): Promise<void> {
    return this.#budgetWrite(async () => {
      this.#expectRevision(expectedRevision)
      let state = this.#state
      const policyEvent = this.#policyChange(state, policy, ids.policy)
      const events: LeadJournalEvent[] = []
      const preflight = (event: LeadJournalEvent) => {
        if (event.type === 'card') admit?.(state, event.card)
        const prepared = prepareLeadJournalRecord({ version: 1, seq: state.seq + 1, ...event }, this.security)
        const record = this.storage.prepare ? this.storage.prepare(prepared, state) : prepared
        state = reduceLeadRecord(state, record)
      }
      if (policyEvent) { preflight(policyEvent); events.push(policyEvent) }
      const capsEvent = this.#capsChange(state, caps, { id: ids.caps, revision: 1 }, now)
      if (capsEvent) { preflight(capsEvent); events.push(capsEvent) }
      for (const event of events) await this.#append(event)
    }, stopEffects)
  }
  #resultFenced(): boolean {
    const op = this.#state.publication
    const retry = this.#state.retryResult
    return !!(retry && retry.goal === (this.#state.budget?.logicalGoalId ?? null) && retry.digest === this.#state.contract?.digest &&
      !['accepted', 'declined', 'stopped'].includes(this.#state.phase) && !this.#state.decidedCards.includes(`${retry.id}:${retry.revision}`) && this.#state.cards.some(card => card.id === retry.id && card.revision === retry.revision)) ||
      this.#state.phase === 'following' || !!(op && op.stage !== 'superseded' && !(op.stage === 'needs-you' && op.effectStarted === false) &&
      !this.#state.decidedCards.includes(`${op.decision.cardId}:${op.decision.expectedRevision}`) &&
      this.#state.cards.some(card => card.id === op.decision.cardId && card.revision === op.decision.expectedRevision && card.contractDigest === op.decision.contractDigest))
  }
  restoreResult(id: string, revision: number): Promise<void> { return this.#queue(async () => {
    if (this.#resultFenced()) return
    await this.#append({ type: 'restore-result', id, revision })
  }) }
  /** Call only after acquiring exclusive ownership, before sending any requests. */
  recoverUnsettledRequests(): Promise<void> { return this.#queue(async () => {
    for (const request of this.#state.budget?.requests ?? []) if (!request.uncertain)
      await this.#append({ type: 'budget', event: { version: 1, type: 'uncertain', now: this.#state.budget!.now, requestId: request.reservation.requestId } })
  }) }
  invalidateResults(): Promise<void> { return this.#queue(async () => {
    const op = this.#state.publication
    // Recheck on the writer queue: the child's snapshot predates this RPC.
    if (this.#resultFenced()) return
    if (op?.stage === 'needs-you' && op.effectStarted === false) await this.#append({ type: 'publication', operation: { ...op, stage: 'superseded' }, pr: null })
    const open = this.#state.cards.filter(card => card.type === 'result' && !this.#state.decidedCards.includes(`${card.id}:${card.revision}`))
    if (!open.length) return
    await this.#append({ type: 'invalidate-results' })
    for (const card of open) this.#withdrawn.add(`${card.id}:${card.revision}`)
    // A goal offers a handful of results; keep the newest few hundred at most.
    for (const key of this.#withdrawn) { if (this.#withdrawn.size <= 256) break; this.#withdrawn.delete(key) }
  }) }
  /** Whether a result card is decided only because an invalidation took it back, not because anyone chose. */
  withdrawn(cardId: string, revision: number): boolean {
    const key = `${cardId}:${revision}`
    return this.#withdrawn.has(key) && this.#state.decidedCards.includes(key)
  }
  /** Host-only bookkeeping from a fresh owned execution read. Unlike crash
   * recovery this observes a completed start while the management child lives;
   * it cannot discover a new run, resolve an uncertain start or authorize work. */
  observeSettledRun(runId: string, firstRoundId: string): Promise<void> { return this.#queue(async () => {
    const run = this.#state.runs.find(run => run.runId === runId)
    const attempt = run && this.#state.attempts.get(run.correlationId)
    if (!run || attempt?.method !== 'flow/start-goal' || attempt.outcome !== 'succeeded' || attempt.resolutionPending || attempt.contested)
      throw new Error('lead-run-unowned')
    // Repair preparation meters the old settled Flow before opening its held
    // round. That earlier snapshot cannot retire the journaled reopening.
    if (this.#state.handbacks.some(op => op.runId === runId && op.stage === 'prepared')) return
    const rows = attempt.evidence === null ? [] : parseLeadRunEvidence(attempt.evidence)
    const previous = rows.find(row => row.runId === runId)
    if (previous && (previous.teamId !== run.teamId || previous.firstRoundId !== firstRoundId)) throw new Error('lead-run-evidence-conflict')
    await this.#record(attempt.id, [...rows.filter(row => row.runId !== runId), { ...run, firstRoundId, terminal: true }], false)
  }) }
  setPolicy(policy: LeadPermissionPolicy): Promise<void> { return this.#queue(() => this.#append({ type: 'policy', policy })) }
  offerCard(card: LeadCard, admit?: (card: LeadCard) => void): Promise<LeadCard> { return this.#queue(async () => {
    // A prepared, effect-free intent may still be superseded. Once publication
    // starts, only the host's final decision can release its exact result.
    const op = this.#state.publication
    const personPush = card.type === 'result' && card.publication === 'push' && card.publicationSource && this.#state.phase === 'following'
    if (card.type === 'result' && this.#resultFenced() && !personPush && !(this.#state.phase !== 'following' && op?.stage === 'push-prepared' && op.effectStarted === false))
      throw Object.assign(new Error('lead-card-stale'), { wireCode: 'lead-card-stale' })
    const revisions = new Map(this.#state.cards.map(card => [card.id, card.revision]))
    admit?.(card)
    await this.#append({ type: 'card', card })
    // Read the prepared, durable snapshot, never the caller after a broker hook.
    return structuredClone(this.#state.cards.find(card => revisions.get(card.id) !== card.revision)!)
  }) }

  /** Host-clock expiry only; the reducer reconstructs the unchanged approved card. */
  renewPlan(now: number, admit?: (card: LeadCard) => void): Promise<void> { return this.#queue(async () => {
    const state = this.#state
    if (!state.consent || state.consent.renewalCardRevision !== undefined || state.consent.expiresAt > now || state.budget?.stop || state.recoveryBlocked || state.workerApprovals.some(rule => rule.dispatch) ||
      ['stopped', 'accepted', 'declined', 'following'].includes(state.phase) || hasPendingLeadPlan(state)) return
    const old = [...state.cards].reverse().find(card => card.type === 'plan' && card.contractDigest === state.contract?.digest &&
      JSON.stringify(card.contract) === JSON.stringify(state.contract) && state.decidedCards.includes(`${card.id}:${card.revision}`))
    if (!old) return
    if (state.cards.length >= 64) {
      if (state.managementReason !== 'lead-renewal-blocked')
        await this.#append({ type: 'management', phase: 'waiting-for-user', reason: 'lead-renewal-blocked' })
      return
    }
    const freshId = `renewal-${state.seq + 1}`
    const preflight = (cardId?: string) => {
      const event = { type: 'renew-plan' as const, now, ...(cardId ? { cardId } : {}) }
      const next = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, ...event })
      const card = next.cards.find(card => !state.cards.some(old => old.id === card.id && old.revision === card.revision))!
      admit?.(card)
      return event
    }
    let event: ReturnType<typeof preflight>
    try { event = preflight() }
    catch { event = preflight(freshId) }
    await this.#append(event)
  }) }
  async decideCard(input: LeadCardDecision, expiresAt: number | null = null, stopEffects?: () => Promise<void>, beforeDecision?: () => Promise<void>, committed?: () => void): Promise<void> {
    const decision = parseLeadCardDecision(input)
    return this.#budgetWrite(async () => {
      const card = this.#state.cards.find(card => card.id === decision.cardId)
      if (this.#state.decidedCards.includes(`${decision.cardId}:${decision.expectedRevision}`))
        throw Object.assign(new Error('lead-card-decided'), { wireCode: 'lead-card-decided' })
      if (!card || card.revision !== decision.expectedRevision || card.type !== decision.cardType || card.contractDigest !== decision.contractDigest)
        throw Object.assign(new Error('lead-card-stale'), { wireCode: 'lead-card-stale' })
      if (this.#state.decidedCards.includes(`${card.id}:${card.revision}`))
        throw Object.assign(new Error('lead-card-decided'), { wireCode: 'lead-card-decided' })
      if (card.type === 'plan' && decision.choice === 'approve' && this.#state.policy?.revision !== card.contract.policyRevision &&
        !isLeadPlanRenewal(this.#state, card))
        throw Object.assign(new Error('lead-card-stale'), { wireCode: 'lead-card-stale' })
      // Validate the immutable card and reducer transition before any human side effect.
      reduceLeadRecord(this.#state, { version: 1, seq: this.#state.seq + 1, type: 'card-decision', decision, expiresAt })
      try { await beforeDecision?.() }
      catch (error) {
        if (card.type === 'result' && (error as { wireCode?: unknown })?.wireCode === 'lead-gate-save-failed')
          await this.#append({ type: 'retry-result', id: card.id, revision: card.revision })
        else if (this.#state.retryResult?.id === card.id && this.#state.retryResult.revision === card.revision) {
          await this.#append({ type: 'invalidate-results' })
        }
        throw error
      }
      await this.#append({ type: 'card-decision', decision, expiresAt }, committed)
    }, stopEffects)
  }
  /** Caller must await durable admission before sending a paid request or opening a round. */
  updateBudget(event: LeadBudgetEvent, stopEffects?: () => Promise<void>): Promise<LeadBudgetLedger> {
    return this.#budgetWrite(async () => {
      await this.#append({ type: 'budget', event })
      return structuredClone(this.#state.budget!)
    }, stopEffects)
  }
  #capsChange(state: LeadState, value: LeadCaps, card: { id: string; revision: number }, now: number): LeadJournalEvent | null {
    const caps = parseLeadCaps(value), budget = state.budget
    if (!budget || !Number.isSafeInteger(now) || now < budget.now) throw new Error('lead-budget-refused')
    if (caps.usdMicros === budget.caps.usdMicros && caps.rounds === budget.caps.rounds) return null
    if (caps.usdMicros <= budget.caps.usdMicros && caps.rounds <= budget.caps.rounds)
      return { type: 'budget', event: { version: 1, type: 'tighten', now, caps } }
    if (state.cards.some(card => card.type === 'budget-change' && !state.decidedCards.includes(`${card.id}:${card.revision}`)))
      throw Object.assign(new Error('lead-change-pending'), { wireCode: 'lead-change-pending' })
    return { type: 'card', card: { version: 1, ...card, type: 'budget-change', logicalGoalId: budget.logicalGoalId,
      contractDigest: state.contract?.digest ?? null, previous: { revision: budget.capsRevision, caps: budget.caps }, proposed: caps } }
  }
  changeBudgetCaps(value: LeadCaps, card: { id: string; revision: number }, now: number, stopEffects?: () => Promise<void>, expectedRevision?: number, admit?: (card: LeadCard) => void): Promise<LeadCard | null> {
    return this.#budgetWrite(async () => {
      this.#expectRevision(expectedRevision)
      const event = this.#capsChange(this.#state, value, card, now)
      if (!event) return null
      if (event.type === 'card') admit?.(event.card)
      await this.#append(event)
      return event.type === 'card' ? structuredClone(this.#state.cards.at(-1)!) : null
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
  beginGoal(id: string, now: number): Promise<void> { return this.#queue(() => this.#append({ type: 'new-goal', id, now })) }
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
  /** Host-only proof after an ordinary chat preflight refused, before its effect
   * boundary. This is deliberately absent from LeadJournalPort and child RPC.
   * The receipt is consumed by this live execute only; a crash still fails closed. */
  noteDispatchNotStarted(id: string): void {
    const attempt = this.#state.attempts.get(id)
    if (!attempt || attempt.kind !== 'mutation' || attempt.phase !== 'started' || !attempt.dispatched || attempt.effect !== 'allow' ||
      !['lead/chat/start', 'lead/chat/send', 'lead/chat/stop'].includes(attempt.method)) throw new Error('lead-chat-preflight-receipt')
    this.#dispatchNotStarted.add(id)
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
      const cancellation = isLeadCancellation(method, action)
      // Status reads remain available after Stop so the final report can observe desk state.
      if (tier !== 'read' && !cancellation && (['stopped', 'accepted', 'declined'].includes(this.#state.phase) || leadWorkerDispatchBlockedByOpenPr(this.#state) || hasPendingLeadPlan(this.#state) ||
        this.#state.recoveryBlocked || this.#state.orphanedWorkerDispatch || this.#state.workerApprovals.some(rule => rule.dispatch) || [...this.#state.attempts.values()].some(attempt => attempt.kind === 'mutation' && (attempt.outcome === 'uncertain' || attempt.phase === 'started' && attempt.dispatched))))
        decision = refusal('start', 'Management is stopped pending recovery or user action')
      if (method === 'flow/start-goal' && (!step || step.state !== 'pending' || request.start?.id !== step.id ||
        this.#state.steps.find(step => step.state !== 'started')?.id !== step.id)) decision = refusal('start', 'Step is unapproved, out of order or already admitted')
      if (decision.effect === 'allow' && method === 'flow/start-goal' && step) {
        const index = this.#state.steps.indexOf(step)
        const previous = this.#state.steps[index - 1]
        const owned = previous && this.#state.runs.find(run => run.correlationId === previous.attemptId)
        if (index > 0 && (!owned || input.predecessor?.runId !== owned.runId || input.predecessor.ready !== true))
          decision = refusal('start', input.predecessor?.terminal || !owned ? input.predecessor?.reason ?? 'lead-predecessor-unavailable' : 'lead-predecessor-not-ready')
      }
      await this.#append({ type: 'decision', id, effect: decision.effect, reason: decision.floor ?? 'policy', rule: decision.rule })
      await this.#append({ type: 'dispatch-start', id, dispatched: decision.effect === 'allow' })
      if (decision.effect !== 'allow' || decision.call === null) {
        const outcome: LeadAttemptOutcome = decision.effect === 'ask' ? 'asked' : decision.floor === 'invalid-input' ? 'malformed' : 'denied'
        await this.#append({ type: 'result', id, outcome, identity: null })
        return { decision, outcome }
      }
      // Admission and dispatch-start are durable before releasing the writer.
      // The admitted step reserves this attempt while host writes use the queue.
      return { decision, call: decision.call, tier, cancellation, method }
    }).then(async (prepared): Promise<{ decision: LeadPermissionDecision; outcome: LeadAttemptOutcome; value?: unknown }> => {
      if (prepared.outcome !== undefined) return { decision: prepared.decision, outcome: prepared.outcome }
      const { decision, call, tier, cancellation, method } = prepared
      let result: LeadDispatchResult
      try { result = await dispatch(call, id) } catch {
        const noEffect = this.#dispatchNotStarted.delete(id)
        const outcome = tier === 'read' || cancellation || noEffect ? 'failed' : 'uncertain'
        await this.#queue(async () => {
          await this.#append({ type: 'result', id, outcome, identity: null })
          if (canReportLeadChatEffect(this.#state, this.#state.attempts.get(id)!))
            await this.#append({ type: 'recovery-report', id })
        })
        return { decision, outcome }
      }
      this.#dispatchNotStarted.delete(id)
      if (method === 'flow/start-goal' && result?.created === false && result.identity === null) {
        await this.#queue(() => this.#append({ type: 'result', id, outcome: 'failed', identity: null }))
        return { decision, outcome: 'failed', value: result.value }
      }
      let identity: LeadRunIdentity | null = null
      try { identity = method !== 'flow/start-goal' || result.identity === null ? null : parseLeadRunIdentity(result.identity) } catch { /* An unprovable start is uncertain. */ }
      const outcome = method === 'flow/start-goal' && (identity === null || identity.correlationId !== id) ? 'uncertain' : 'succeeded'
      await this.#queue(() => this.#append({ type: 'result', id, outcome, identity: outcome === 'succeeded' ? identity : null }))
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
    if (this.#childLive) return Promise.reject(new Error('lead-recovery-live-child'))
    this.#recovering++
    return this.#queue(async () => {
      if (this.#childLive) throw new Error('lead-recovery-live-child')
      const actions: LeadRecoveryAction[] = []
      for (const pending of [...this.#state.attempts.values()].filter(attempt => !attempt.recoveryReported && (attempt.phase !== 'finished' || attempt.outcome === 'uncertain' || attempt.resolutionPending || this.#state.runs.some(run => run.correlationId === attempt.correlationId)))) {
        if (pending.phase === 'attempted') await this.#append({ type: 'decision', id: pending.id, effect: 'deny', reason: 'recovery', rule: null })
        if (pending.phase === 'attempted' || pending.phase === 'decided') await this.#append({ type: 'dispatch-start', id: pending.id, dispatched: false })
        if (pending.phase !== 'finished') await this.#append({ type: 'result', id: pending.id,
          outcome: pending.dispatched ? isLeadCancellation(pending.method, pending.action) ? 'failed' : 'uncertain' : 'interrupted', identity: null })
        if (!pending.dispatched) { await this.#append({ type: 'recovery-report', id: pending.id }); actions.push({ id: pending.id, type: 'not-dispatched' }); continue }
        if (pending.kind === 'read') { await this.#append({ type: 'recovery-report', id: pending.id }); actions.push({ id: pending.id, type: 'retry-read' }); continue }
        if (canReportLeadChatEffect(this.#state, this.#state.attempts.get(pending.id)!)) {
          await this.#append({ type: 'recovery-report', id: pending.id })
          actions.push({ id: pending.id, type: 'needs-user' })
          continue
        }
        if (isLeadCancellation(pending.method, pending.action)) continue
        // Chat effects have no Flow identity to look up. Any unexpected binding
        // or conflict stays fenced rather than being resolved by an empty lookup.
        if (pending.method === 'lead/chat/start' || pending.method === 'lead/chat/send') continue
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
        const ownGoal = this.#state.runs.find(run => run.correlationId === pending.correlationId)?.teamId
        const firstGoal = sortEvidence([...retained.values(), ...observed.filter(run => !foreign.has(run.runId))])[0]?.teamId ?? null
        // Distinct approved steps may own distinct Goals. A lookup must still
        // agree within one attempt and with every identity already retained.
        const priorPlan = this.#state.runs.some(run => !this.#state.steps.some(step => step.attemptId === run.correlationId))
        const goalId = ownGoal ?? ((this.#state.contract?.steps.length ?? 0) > 1 || priorPlan ? firstGoal : this.#state.budget?.goalId ?? firstGoal)
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
    }).finally(() => { this.#recovering-- })
  }
}
/** The host owns the sole writer for a Lead. Child tools must share that journal
 * port (over IPC when out of process). Concurrent instances over the same durable
 * storage are unsupported; storage ports do not expose an exclusive-owner lock. */
export const createLeadJournal = async (storage: LeadJournalStorage, security: LeadJournalSecurity = {}): Promise<LeadJournal> => {
  return new LeadJournal(storage, await storage.read(), security, storage.checkpoint?.() ?? null)
}
