import { CLIENT_ACTION_TIERS, CLIENT_METHODS, type ClientMethodName } from './client-surface.js'
import type { CeilingLevel } from './evidence.js'
import type { FlowSeat } from './flow.js'
import { flowSeatValidator } from './flow-seat.js'
import { isBoolean, isObject, literalUnion, optional, ValidationError, type Validator } from './validate.js'

/** Versioned plain data only. Provider credentials and transport descriptors are private to the child bootstrap. */
export const LEAD_VERSION = 1
export const LEAD_SUPPORTED_VERSIONS = Object.freeze([LEAD_VERSION] as const)
export const LEAD_LIMITS = {
  idChars: 256, textChars: 16_384, pathChars: 4_096,
  steps: 64, assignments: 64, assertions: 128, evidence: 128,
  rules: 128, variables: 64, messages: 256, cards: 64, rounds: 100,
  ipcBytes: 1_048_576,
  /** One million USD per field; even three attributed totals fit safely in an integer. */
  maxUsdMicros: 1_000_000_000_000,
} as const

/** Nonnegative safe integer, advanced by nextLeadRevision; source revisions remain opaque strings. */
export type LeadRevision = number
export type LeadUsdMicros = number
export interface LeadCaps {
  /** Observed worker spend stops at this threshold; this is not an invoice ceiling. Zero closes admission. */
  readonly usdMicros: LeadUsdMicros
  /** Total rounds admitted across every execution of this logical goal. */
  readonly rounds: number
}
/** Canonical identity supplied by the host, never inferred by the portable loop. */
export interface LeadProject { readonly id: string; readonly path: string }
export interface LeadAssignment {
  readonly role: string
  readonly agent: string
  /** Flow's structured map preserves slash-bearing model ids without compact-seat ambiguity. */
  readonly seat: FlowSeat
  readonly ceiling: CeilingLevel
}
export interface LeadPlanStep {
  readonly id: string
  readonly title: string
  readonly flow: string
  readonly sourceRevision: string
  readonly variables: Readonly<Record<string, string>>
  readonly attendance: 'attended' | 'unattended'
  readonly assignments: readonly LeadAssignment[]
}
export interface LeadAssertion {
  readonly id: string
  readonly kind: 'check' | 'review' | 'blocking-findings' | 'diff'
  readonly description: string
}
export interface LeadAcceptanceContract {
  readonly version: 1
  readonly revision: LeadRevision
  /** Host-computed SHA-256 of the frozen approval scope; validation checks its spelling, not its authenticity. */
  readonly digest: string
  readonly goal: string
  readonly project: LeadProject
  readonly policyRevision: LeadRevision
  /** Array order is execution order. */
  readonly steps: readonly LeadPlanStep[]
  readonly assertions: readonly LeadAssertion[]
  readonly caps: LeadCaps
}
export interface LeadEvidenceReference {
  readonly kind: 'check' | 'review' | 'finding' | 'diff' | 'spend'
  readonly id: string
  readonly revision: string
}
export interface LeadAssertionResult {
  readonly assertionId: string
  readonly status: 'pending' | 'passed' | 'failed' | 'unknown'
  readonly revision: LeadRevision
  readonly contractRevision: LeadRevision
  readonly evidence: readonly LeadEvidenceReference[]
  readonly reason: string | null
}
export type LeadPermissionMode = 'plan' | 'default' | 'manage'
export interface LeadPermissionRule {
  readonly id: string
  readonly effect: 'allow' | 'ask' | 'deny'
  readonly method: ClientMethodName
  /** Exact action/project match; null means every action/project within the effective contract. */
  readonly action: string | null
  readonly project: string | null
}
export interface LeadPermissionPolicy {
  readonly version: 1
  readonly revision: LeadRevision
  readonly mode: LeadPermissionMode
  readonly rules: readonly LeadPermissionRule[]
}
export type LeadStopReason = 'budget' | 'rounds' | 'unknown-spend' | 'cancelled' | 'connection-lost' | 'recovery' | 'error'
export interface LeadBudgetState {
  readonly version: 1
  readonly revision: LeadRevision
  readonly caps: LeadCaps
  /** Non-overlapping attributed totals. Outstanding Lead requests reserve separately. */
  readonly leadUsdMicros: LeadUsdMicros
  readonly workerUsdMicros: LeadUsdMicros
  readonly reservedUsdMicros: LeadUsdMicros
  readonly roundsAdmitted: number
  readonly spend: 'known' | 'unknown' | 'stale' | 'partial' | 'ambiguous'
  /** Durable latch; a higher cap alone does not clear it. */
  readonly stop: { readonly reason: LeadStopReason; readonly revision: LeadRevision } | null
}
/** Trusted owner input, never model output. Observations are cumulative worker-only
 * totals for their named executions; alternative sources must never be added.
 * A terminal observation names one run and its final cost, retained without expiry. */
export type LeadBudgetEvent = { readonly version: 1; readonly now: number } & (
  | { readonly type: 'initialize'; readonly logicalGoalId: string; readonly caps: LeadCaps; readonly freshnessMs: number }
  | ({ readonly type: 'bind'; readonly goalId: string; readonly executionId: string } & (
      /** A start binding always carries its host-proven first-round identity. */
      | { readonly startId: string; readonly firstRoundId: string }
      | { readonly startId?: null; readonly firstRoundId?: never }
    ))
  /** Reserve all potential input at the most expensive input/cache rate. */
  | { readonly type: 'reserve'; readonly requestId: string; readonly inputTokens: number; readonly maxOutputTokens: number;
      readonly inputUsdMicrosPerMillion: number; readonly outputUsdMicrosPerMillion: number;
      readonly cacheReadUsdMicrosPerMillion: number; readonly cacheWriteUsdMicrosPerMillion: number }
  /** Actual inputTokens exclude the separately billed cache-read/write counts. */
  | { readonly type: 'settle'; readonly requestId: string; readonly inputTokens: number; readonly outputTokens: number;
      readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number }
  | { readonly type: 'uncertain'; readonly requestId: string }
  /** Conservatively settle a possibly billed request at its full reservation. */
  | { readonly type: 'write-off'; readonly requestId: string }
  | { readonly type: 'observe'; readonly at: number; readonly revision: number; readonly source: 'insight/goal' | 'worker-samples';
      readonly sourceIds: readonly string[]; readonly goalId: string; readonly executionIds: readonly string[];
      readonly quality: LeadBudgetState['spend']; readonly usdMicros: number | null; readonly terminal?: boolean }
  | { readonly type: 'start'; readonly startId: string }
  | { readonly type: 'round'; readonly executionId: string; readonly roundId: string }
  | { readonly type: 'tighten'; readonly caps: LeadCaps }
  | { readonly type: 'stop'; readonly reason: LeadStopReason }
)
interface LeadCardBase {
  readonly version: 1
  readonly id: string
  readonly revision: LeadRevision
}
export type LeadCard = (LeadCardBase & { readonly contractDigest: string } & (
  | { readonly type: 'plan'; readonly contract: LeadAcceptanceContract }
  | { readonly type: 'waiting'; readonly kind: 'person' | 'worker-approval'; readonly runId: string;
      readonly personCardId: string | null; readonly summary: string; readonly assertions: readonly LeadAssertionResult[] }
  | { readonly type: 'result'; readonly outcome: 'reviewed' | 'accepted' | 'declined'; readonly summary: string;
      readonly assertions: readonly LeadAssertionResult[]; readonly budget: LeadBudgetState }
)) | (LeadCardBase & { readonly type: 'stopped'; readonly contractDigest: string | null;
  readonly reason: LeadStopReason; readonly summary: string; readonly budget: LeadBudgetState }
) | (LeadCardBase & {
  readonly type: 'budget-change'; readonly contractDigest: string | null; readonly logicalGoalId: string
  readonly previous: { readonly revision: LeadRevision; readonly caps: LeadCaps }; readonly proposed: LeadCaps
}) | (LeadCardBase & {
  readonly type: 'permission-change'
  /** Null before there is an approved contract. The immutable card ID/revision binds the policy pair. */
  readonly contractDigest: string | null
  readonly previous: LeadPermissionPolicy
  readonly proposed: LeadPermissionPolicy
})
/** Private recipe choices: person/result acceptance maps accept/decline to accepted/declined. */
export const LEAD_CARD_CHOICES = {
  plan: ['approve', 'decline'], 'permission-change': ['approve', 'decline'], 'budget-change': ['approve', 'decline'],
  waiting: ['accept', 'decline'], result: ['accept', 'decline'], stopped: [],
} as const
/** Authenticated window input only. Never a child command or a worker approval answer. */
export interface LeadCardDecision {
  readonly version: 1
  readonly cardId: string
  readonly cardType: Exclude<LeadCard['type'], 'stopped'>
  readonly expectedRevision: LeadRevision
  readonly contractDigest: string | null
  readonly choice: 'approve' | 'decline' | 'accept'
}
export interface LeadMessage {
  readonly version: 1
  readonly id: string
  readonly revision: LeadRevision
  readonly role: 'user' | 'assistant' | 'system'
  /** Untrusted prose; rendering still requires the transcript sanitizer. */
  readonly text: string
}
export type LeadThreadState = 'draft' | 'planning' | 'awaiting-plan' | 'running' | 'waiting-for-user' | 'accepted' | 'declined' | 'stopped'
export const LEAD_MANAGEMENT_REASONS = [
  'lead-renewal-blocked',
  'lead-disabled', 'lead-key-changed', 'lead-host-shutdown', 'lead-child-exited', 'lead-ownership-withdrawn',
  'lead-result-awaiting-person', 'lead-result-revisions-exhausted', 'lead-start-binding-failed', 'lead-plan-refused', 'lead-activity-failed', 'lead-subscription-failed', 'lead-tools-refused',
  'lead-card-too-large', 'lead-send-deadline', 'lead-request-refused', 'lead-request-rate-limited', 'lead-request-failed', 'lead-request-max-tokens', 'lead-request-invalid-response', 'lead-request-cancelled', 'lead-request-uncertain',
] as const
export interface LeadThread {
  readonly version: 1
  readonly id: string
  readonly revision: LeadRevision
  readonly state: LeadThreadState
  readonly project: LeadProject | null
  /** Journal-window decision: omitted older messages stay in the append-only journal, the persistence record.
   * Projections contain the most recent messages and active/recent cards within their limits;
   * hosts must window before projecting, never persist the projection as the entire conversation. */
  readonly olderMessages: number
  readonly messages: readonly LeadMessage[]
  readonly cards: readonly LeadCard[]
  /** Host journal positions remain fixed when a card gets a newer revision. */
  readonly cardPositions?: Readonly<Record<string, number>>
  readonly contract?: LeadAcceptanceContract | null
  readonly budget?: LeadBudgetState | null
}
export interface LeadSettingsProjection {
  readonly version: 1
  readonly model: string
  readonly key: { readonly configured: boolean; readonly protection: 'encrypted' | 'unavailable' }
  readonly policy: LeadPermissionPolicy
  readonly caps: LeadCaps
}
export interface LeadHostProjection {
  readonly version: 1
  readonly revision: LeadRevision
  readonly thread: LeadThread
  readonly settings: LeadSettingsProjection
}
export type LeadPersonAction = 'resume' | 'decide-plan' | null
/** Window projection adds the host's guarded way out; child observations grant no control. */
export interface LeadWindowProjection extends LeadHostProjection {
  readonly requestInFlight: boolean
  readonly wayOut: LeadPersonAction
  readonly waitReason: typeof LEAD_MANAGEMENT_REASONS[number] | null
  readonly planConsentExpiresAt: number | null
}
export interface LeadProjectionFailure { readonly version: 1; readonly revision: LeadRevision; readonly error: 'lead-projection-failed' }
export type LeadChanged = LeadWindowProjection | LeadProjectionFailure
export const LEAD_CONTROL_REFUSALS = ['lead-unavailable', 'lead-operation-refused', 'lead-secret-refused', 'lead-revision-stale',
  'lead-no-person-wait', 'lead-plan-pending', 'lead-card-stale', 'lead-card-decided', 'lead-worker-approval',
  'lead-gate-changed', 'lead-gate-save-failed', 'lead-settings-combination', 'lead-evidence-read-refused',
  'lead-change-pending', 'lead-card-too-large', 'lead-projection-failed', 'lead-key-missing', 'lead-secret-in-thread',
  'lead-thread-closed', 'lead-budget-stopped', 'lead-protection-unavailable', 'lead-request-in-flight'] as const
export type LeadControlRefusal = typeof LEAD_CONTROL_REFUSALS[number]
/** Window-only input. Credentials are consumed by the broker lifecycle, never persisted as settings. */
export interface LeadSettingsUpdate {
  readonly expectedRevision: LeadRevision
  readonly policy?: LeadPermissionPolicy
  readonly caps?: LeadCaps
  readonly credential?: { readonly provider: 'anthropic'; readonly key: string | null }
}
export interface LeadThreadSend { readonly idempotencyKey: string; readonly text: string }
/** Stable first result, retained across retries and journal recovery. */
export interface LeadSendReceipt { readonly messageId: string; readonly revision: LeadRevision }
/** Public control vocabulary carries no secrets and grants no human decision authority. */
export type LeadChildControl = { readonly version: 1 } & (
  | { readonly type: 'initialize'; readonly thread: LeadThread; readonly model: string;
      readonly policy: LeadPermissionPolicy; readonly budget: LeadBudgetState }
  | { readonly type: 'observe'; readonly projection: LeadHostProjection }
  | { readonly type: 'cancel'; readonly reason: LeadStopReason }
)
export type LeadChildEvent = { readonly version: 1 } & (
  | { readonly type: 'ready' }
  | { readonly type: 'projection'; readonly thread: LeadThread }
  | { readonly type: 'stopped'; readonly reason: LeadStopReason }
)

const fail = (path: string, message: string): never => { throw new ValidationError(path, message) }
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER): Validator<number> => (value, path = '') =>
  typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max
    ? value : fail(path, `expected safe integer in ${min}..${max}`)
const revision = integer()
const micros = integer(0, LEAD_LIMITS.maxUsdMicros)
const version: Validator<1> = (value, path = '') => value === LEAD_VERSION ? LEAD_VERSION : fail(path, 'unsupported Lead version')
// Supported runtimes provide this ES2024 method; the shared compile-time library is ES2023.
const wellFormed = (value: string) => (value as string & { isWellFormed(): boolean }).isWellFormed()
const boundedText = (max: number, allowEmpty: boolean, controls: RegExp): Validator<string> => (value, path = '') =>
  typeof value === 'string' && wellFormed(value) && (allowEmpty || value.trim().length > 0) && value.length <= max && !controls.test(value)
    ? value : fail(path, `expected ${allowEmpty ? '' : 'nonempty '}string of at most ${max} characters without controls`)
const text = (max: number) => boundedText(max, false, /[\u0000-\u001f\u007f-\u009f]/)
/** Catalogue IDs are filenames, model choices are agent-owned, and repository identities
 * can contain punctuation. Current Flow revisions are hex hashes, but Lead keeps them opaque. */
const opaque = text(LEAD_LIMITS.idChars)
const id: Validator<string> = (value, path = '') => {
  const parsed = text(LEAD_LIMITS.idChars)(value, path)
  return /^[A-Za-z0-9._:/@-]+$/.test(parsed) ? parsed : fail(path, 'invalid Lead identifier')
}
/** Prose preserves LF, CR and tab for Markdown and Flow inputs; other C0, DEL and C1 remain forbidden. */
const proseControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const prose = boundedText(LEAD_LIMITS.textChars, false, proseControls)
/** Empty assistant/tool-only text, optional variable values and absent summaries are legitimate. */
const content = boundedText(LEAD_LIMITS.textChars, true, proseControls)
const digest: Validator<string> = (value, path = '') =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail(path, 'expected SHA-256 digest')
const nullable = <T>(parse: Validator<T>): Validator<T | null> => (value, path) => value === null ? null : parse(value, path)
const list = <T>(parse: Validator<T>, max: number, min = 0, keyOf?: (entry: T) => string): Validator<readonly T[]> => (value, path = '') => {
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail(path, `expected ${min}..${max} entries`)
  const keys = new Set<string>()
  return Array.from({ length: value.length }, (_, index) => {
    const at = `${path}[${index}]`
    if (!Object.hasOwn(value, index)) return fail(at, 'missing array entry')
    const parsed = parse(value[index], at)
    if (keyOf) {
      const key = keyOf(parsed)
      if (keys.has(key)) return fail(at, 'duplicate Lead identity')
      keys.add(key)
    }
    return parsed
  })
}
/** Closed projections: unknown fields must never pass through into the window or IPC. */
const object = <T>(fields: { [K in keyof T]: Validator<T[K]> }): Validator<T> => (value, path = '') => {
  const source = isObject(value, path)
  for (const key of Object.keys(source)) if (!Object.hasOwn(fields, key)) fail(path, 'unexpected Lead field')
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(fields) as (keyof T & string)[]) out[key] = fields[key](source[key], path ? `${path}.${key}` : key)
  return out as T
}
const tag = <T>(branches: Readonly<Record<string, Validator<T>>>): Validator<T> => (value, path = '') => {
  const source = isObject(value, path)
  if (typeof source.type !== 'string' || !Object.hasOwn(branches, source.type)) return fail(path, 'unknown Lead message type')
  return branches[source.type]!(value, path)
}
/** IPC decision: at most one MiB of UTF-8 JSON per control/event, including all nested data.
 * Transports must cap raw frames before parsing too. Recheck validated data so toJSON cannot
 * hide a large in-memory projection. The journal retains data omitted from these windows. */
const ipc = <T>(parse: Validator<T>): Validator<T> => (value, path = '') => {
  const check = (data: unknown) => {
    let json: string | undefined
    try { json = JSON.stringify(data) } catch { return fail(path, 'invalid Lead IPC data') }
    if (json === undefined || new TextEncoder().encode(json).byteLength > LEAD_LIMITS.ipcBytes) fail(path, 'Lead IPC byte limit exceeded')
  }
  check(value)
  const parsed = parse(value, path)
  check(parsed)
  return parsed
}
const variables: Validator<Readonly<Record<string, string>>> = (value, path = '') => {
  const entries = Object.entries(isObject(value, path))
  if (entries.length > LEAD_LIMITS.variables) return fail(path, 'too many variables')
  return Object.fromEntries(entries.map(([key, value]) => {
    if (key === '__proto__') return fail(path, 'forbidden variable key')
    return [id(key, path), content(value, `${path}.${key}`)]
  }))
}
export const parseLeadCaps: Validator<LeadCaps> = object({ usdMicros: micros, rounds: integer(1, LEAD_LIMITS.rounds) })
const projectPath: Validator<string> = (value, path = '') => {
  const parsed = text(LEAD_LIMITS.pathChars)(value, path)
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(parsed) || parsed.split(/[\\/]/).includes('..'))
    return fail(path, 'expected absolute project path without parent traversal')
  return parsed
}
const project: Validator<LeadProject> = object({ id: opaque, path: projectPath })
const boundedSeat: Validator<FlowSeat> = object({
  runtime: opaque, model: optional(opaque), effort: optional(opaque), thinking: optional(isBoolean),
})
const seat: Validator<FlowSeat> = (value, path = '') => {
  // Reuse Flow's semantics, then apply Lead's closed projection and string bounds.
  const parsed = boundedSeat(flowSeatValidator(value, path), path)
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) as unknown as FlowSeat
}
const assignment: Validator<LeadAssignment> = object({ role: id, agent: id, seat, ceiling: literalUnion('read', 'edit', 'publish', 'merge') })
const step: Validator<LeadPlanStep> = object({
  id, title: prose, flow: opaque, sourceRevision: opaque, variables, attendance: literalUnion('attended', 'unattended'),
  assignments: list(assignment, LEAD_LIMITS.assignments, 1, assignment => assignment.role),
})
const assertion: Validator<LeadAssertion> = object({ id, kind: literalUnion('check', 'review', 'blocking-findings', 'diff'), description: prose })
export const parseLeadAcceptanceContract: Validator<LeadAcceptanceContract> = object({
  version, revision, digest, goal: prose, project, policyRevision: revision,
  steps: list(step, LEAD_LIMITS.steps, 1, step => step.id), assertions: list(assertion, LEAD_LIMITS.assertions, 1, assertion => assertion.id), caps: parseLeadCaps,
})
const evidence: Validator<LeadEvidenceReference> = object({ kind: literalUnion('check', 'review', 'finding', 'diff', 'spend'), id, revision: opaque })
export const parseLeadAssertionResult: Validator<LeadAssertionResult> = object({
  assertionId: id, status: literalUnion('pending', 'passed', 'failed', 'unknown'), revision,
  contractRevision: revision, evidence: list(evidence, LEAD_LIMITS.evidence), reason: nullable(prose),
})
const method: Validator<ClientMethodName> = (value, path = '') =>
  typeof value === 'string' && Object.hasOwn(CLIENT_METHODS, value) ? value as ClientMethodName : fail(path, 'method outside client surface')
const ruleShape: Validator<LeadPermissionRule> = object({
  id, effect: literalUnion('allow', 'ask', 'deny'), method, action: nullable(id), project: nullable(opaque),
})
const rule: Validator<LeadPermissionRule> = (value, path = '') => {
  const parsed = ruleShape(value, path)
  if (parsed.action !== null && !Object.hasOwn(CLIENT_ACTION_TIERS, parsed.method))
    fail(path, 'method has no permission actions')
  return parsed
}
export const parseLeadPermissionPolicy: Validator<LeadPermissionPolicy> = object({
  version, revision, mode: literalUnion('plan', 'default', 'manage'), rules: list(rule, LEAD_LIMITS.rules, 0, rule => rule.id),
})
const stopReason = literalUnion('budget', 'rounds', 'unknown-spend', 'cancelled', 'connection-lost', 'recovery', 'error')
const budgetState: Validator<LeadBudgetState> = object({
  version, revision, caps: parseLeadCaps, leadUsdMicros: micros, workerUsdMicros: micros, reservedUsdMicros: micros,
  roundsAdmitted: integer(0, LEAD_LIMITS.rounds), spend: literalUnion('known', 'unknown', 'stale', 'partial', 'ambiguous'),
  stop: nullable(object({ reason: stopReason, revision })),
})
/** The spend observation reaching the cap and its stop latch must land in one journal
 * record, never as separately persisted snapshots. A zero-dollar initial budget includes
 * the latch in its first record too; the reducer must not persist an invalid intermediate. */
export const parseLeadBudgetState: Validator<LeadBudgetState> = (value, path = '') => {
  const parsed = budgetState(value, path)
  const reported = parsed.leadUsdMicros + parsed.workerUsdMicros
  if (parsed.stop !== null && parsed.stop.revision > parsed.revision) fail(path, 'stop revision exceeds budget revision')
  // Tightening can put observed work above either cap. Such snapshots remain valid only
  // after latching stop; never erase observed spend/rounds to make the new cap fit.
  if (parsed.stop === null && (parsed.roundsAdmitted > parsed.caps.rounds ||
    reported >= parsed.caps.usdMicros))
    fail(path, 'budget above allowance requires a stop latch')
  return parsed
}
const budgetBase = { version, now: integer() }
type BudgetOf<T extends LeadBudgetEvent['type']> = Extract<LeadBudgetEvent, { type: T }>
const tokenCount = integer(0, 100_000_000)
const budgetEvent = tag<LeadBudgetEvent>({
  initialize: object<BudgetOf<'initialize'>>({ ...budgetBase, type: literalUnion('initialize'), logicalGoalId: id, caps: parseLeadCaps, freshnessMs: integer(1, 86_400_000) }),
  bind: (value, path) => {
    const { startId, firstRoundId, ...base } = object<Omit<BudgetOf<'bind'>, 'startId' | 'firstRoundId'> & {
      startId?: string | null; firstRoundId?: string
    }>({ ...budgetBase, type: literalUnion('bind'), goalId: id, executionId: id, startId: optional(nullable(id)), firstRoundId: optional(id) })(value, path)
    if (typeof startId === 'string') return { ...base, startId, firstRoundId: id(firstRoundId, path ? `${path}.firstRoundId` : 'firstRoundId') }
    if (firstRoundId !== undefined) fail(path ?? '', 'first round requires its bound start')
    return startId === null ? { ...base, startId } : base
  },
  reserve: object<BudgetOf<'reserve'>>({ ...budgetBase, type: literalUnion('reserve'), requestId: id, inputTokens: tokenCount,
    maxOutputTokens: tokenCount, inputUsdMicrosPerMillion: micros, outputUsdMicrosPerMillion: micros,
    cacheReadUsdMicrosPerMillion: micros, cacheWriteUsdMicrosPerMillion: micros }),
  settle: object<BudgetOf<'settle'>>({ ...budgetBase, type: literalUnion('settle'), requestId: id, inputTokens: tokenCount, outputTokens: tokenCount, cacheReadTokens: optional(tokenCount), cacheWriteTokens: optional(tokenCount) }),
  'write-off': object<BudgetOf<'write-off'>>({ ...budgetBase, type: literalUnion('write-off'), requestId: id }),
  uncertain: object<BudgetOf<'uncertain'>>({ ...budgetBase, type: literalUnion('uncertain'), requestId: id }),
  observe: object<BudgetOf<'observe'>>({ ...budgetBase, type: literalUnion('observe'), at: integer(), revision, source: literalUnion('insight/goal', 'worker-samples'),
    sourceIds: list(id, 128, 0, item => item), goalId: id, executionIds: list(id, LEAD_LIMITS.rounds, 0, item => item),
    quality: literalUnion('known', 'unknown', 'stale', 'partial', 'ambiguous'), usdMicros: nullable(micros), terminal: optional(isBoolean) }),
  start: object<BudgetOf<'start'>>({ ...budgetBase, type: literalUnion('start'), startId: id }),
  round: object<BudgetOf<'round'>>({ ...budgetBase, type: literalUnion('round'), executionId: id, roundId: id }),
  tighten: object<BudgetOf<'tighten'>>({ ...budgetBase, type: literalUnion('tighten'), caps: parseLeadCaps }),
  stop: object<BudgetOf<'stop'>>({ ...budgetBase, type: literalUnion('stop'), reason: stopReason }),
})
export const parseLeadBudgetEvent: Validator<LeadBudgetEvent> = (value, path = '') => {
  const parsed = budgetEvent(value, path)
  if (parsed.type === 'observe' && (parsed.at > parsed.now || parsed.quality === 'known' && (parsed.usdMicros === null || parsed.sourceIds.length === 0) ||
    parsed.terminal && (parsed.executionIds.length !== 1 || parsed.quality !== 'known')))
    fail(path, 'invalid spend observation')
  return Object.fromEntries(Object.entries(parsed).filter(([, item]) => item !== undefined)) as LeadBudgetEvent
}
const cardBase = { version, id, revision, contractDigest: digest }
type CardOf<T extends LeadCard['type']> = Extract<LeadCard, { type: T }>
const card = tag<LeadCard>({
  plan: object<CardOf<'plan'>>({ ...cardBase, type: literalUnion('plan'), contract: parseLeadAcceptanceContract }),
  'permission-change': object<CardOf<'permission-change'>>({ ...cardBase, contractDigest: nullable(digest), type: literalUnion('permission-change'), previous: parseLeadPermissionPolicy, proposed: parseLeadPermissionPolicy }),
  'budget-change': object<CardOf<'budget-change'>>({ ...cardBase, contractDigest: nullable(digest), type: literalUnion('budget-change'), logicalGoalId: id,
    previous: object({ revision, caps: parseLeadCaps }), proposed: parseLeadCaps }),
  waiting: object<CardOf<'waiting'>>({ ...cardBase, type: literalUnion('waiting'), kind: literalUnion('person', 'worker-approval'), runId: id,
    personCardId: nullable(id), summary: content, assertions: list(parseLeadAssertionResult, LEAD_LIMITS.assertions, 0, result => result.assertionId) }),
  result: object<CardOf<'result'>>({ ...cardBase, type: literalUnion('result'), outcome: literalUnion('reviewed', 'accepted', 'declined'),
    summary: content, assertions: list(parseLeadAssertionResult, LEAD_LIMITS.assertions, 0, result => result.assertionId), budget: parseLeadBudgetState }),
  stopped: object<CardOf<'stopped'>>({ ...cardBase, contractDigest: nullable(digest), type: literalUnion('stopped'), reason: stopReason, summary: content, budget: parseLeadBudgetState }),
})
export const parseLeadCard: Validator<LeadCard> = (value, path = '') => {
  const parsed = card(value, path)
  if (parsed.type === 'plan' && parsed.contractDigest !== parsed.contract.digest) fail(path, 'plan card digest differs from contract')
  if (parsed.type === 'waiting' && parsed.kind === 'worker-approval' && parsed.personCardId !== null) fail(path, 'worker approval cannot be a person decision')
  if (parsed.type === 'waiting' && parsed.kind === 'person' && parsed.personCardId === null) fail(path, 'person decision requires a live gate identifier')
  // Policy proposals are immutable at this card revision. Replacing either policy must advance it.
  // Before applying a click the host revalidates the current policy and the live contract/gate;
  // a digest is never used as a substitute for the policy pair when no contract exists.
  if (parsed.type === 'permission-change' && parsed.proposed.revision <= parsed.previous.revision) fail(path, 'policy proposal must advance its revision')
  if (parsed.type === 'budget-change' && parsed.proposed.usdMicros <= parsed.previous.caps.usdMicros && parsed.proposed.rounds <= parsed.previous.caps.rounds)
    fail(path, 'budget proposal must increase an allowance')
  return parsed
}
const decision: Validator<LeadCardDecision> = object({
  version, cardId: id, cardType: literalUnion('plan', 'permission-change', 'budget-change', 'waiting', 'result'),
  expectedRevision: revision, contractDigest: nullable(digest), choice: literalUnion('approve', 'decline', 'accept'),
})
export const parseLeadCardDecision: Validator<LeadCardDecision> = (value, path = '') => {
  const parsed = decision(value, path)
  if (!(LEAD_CARD_CHOICES[parsed.cardType] as readonly string[]).includes(parsed.choice)) fail(path, 'choice is not allowed for this card type')
  if (!['permission-change', 'budget-change'].includes(parsed.cardType) && parsed.contractDigest === null) fail(path, 'decision requires a contract digest')
  return parsed
}
/** Structural parsing alone cannot authorize a click. Call against the live immutable card immediately before effects. */
export const parseLeadCardDecisionFor = (value: unknown, current: unknown): LeadCardDecision => {
  const parsed = parseLeadCardDecision(value)
  const card = parseLeadCard(current)
  if (parsed.cardId !== card.id || parsed.expectedRevision !== card.revision || parsed.cardType !== card.type || parsed.contractDigest !== card.contractDigest)
    return fail('', 'stale or mismatched card decision')
  if ((card.type === 'waiting' && card.kind === 'worker-approval') || (card.type === 'result' && card.outcome !== 'reviewed'))
    return fail('', 'card has no pending person decision')
  return parsed
}
export const parseLeadMessage: Validator<LeadMessage> = object({ version, id, revision, role: literalUnion('user', 'assistant', 'system'), text: content })
const cardPositions: Validator<Readonly<Record<string, number>>> = (value, path = '') => {
  const entries = Object.entries(isObject(value, path))
  if (entries.length > LEAD_LIMITS.cards) fail(path, 'too many card positions')
  return Object.fromEntries(entries.map(([key, value]) => [id(key, path), integer(1)(value, path)]))
}
export const parseLeadThread: Validator<LeadThread> = object({
  version, id, revision, state: literalUnion('draft', 'planning', 'awaiting-plan', 'running', 'waiting-for-user', 'accepted', 'declined', 'stopped'),
  // One current snapshot per card. Revisions belong to each card, so different cards may
  // share revision 1; the state machine must compare old/new revisions when replacing a card.
  project: nullable(project), olderMessages: integer(), cardPositions: optional(cardPositions),
  contract: optional(nullable(parseLeadAcceptanceContract)), budget: optional(nullable(parseLeadBudgetState)),
  messages: list(parseLeadMessage, LEAD_LIMITS.messages, 0, message => message.id), cards: list(parseLeadCard, LEAD_LIMITS.cards, 0, card => card.id),
})
/** Keep the largest newest suffix within the thread's UTF-8 JSON budget, without mutating
 * the source or dropping cards. Journal readers first hydrate at most LEAD_LIMITS.messages
 * newest messages, with olderMessages accounting for the rest. This helper adds byte-based
 * omissions. Reserve the control/event envelope's exact overhead from ipcBytes before calling,
 * then validate the completed frame. Oversized cards/metadata fail closed instead of vanishing. */
export const windowLeadThread = (value: unknown, maxBytes: number): LeadThread => {
  const limit = integer(1, LEAD_LIMITS.ipcBytes)(maxBytes, 'maxBytes')
  const thread = parseLeadThread(value)
  const bytesOf = (data: LeadThread | LeadMessage) => new TextEncoder().encode(JSON.stringify(data)).byteLength
  let bytes = bytesOf(thread)
  let offset = 0
  let olderMessages = thread.olderMessages
  while (bytes > limit && offset < thread.messages.length) {
    const previousCount = olderMessages
    olderMessages = integer()(olderMessages + 1, 'olderMessages')
    // Removing an array entry removes its JSON plus one comma unless it was the last.
    bytes -= bytesOf(thread.messages[offset]!) + (thread.messages.length - offset > 1 ? 1 : 0)
    bytes += String(olderMessages).length - String(previousCount).length
    offset += 1
  }
  if (bytes > limit) return fail('', 'Lead cards and metadata exceed the thread byte budget')
  return { ...thread, olderMessages, messages: thread.messages.slice(offset) }
}
/** Migration decision: journal recovery calls this hook before projecting. Only v1 exists today.
 * A future version adds its own strict old-version reader and explicit data migration here;
 * it must never pass unknown fields through, infer an absent version, or replay effects. */
export const migrateLeadThread: Validator<LeadThread> = (value, path = '') => {
  const source = isObject(value, path)
  switch (source.version) {
    case 1: return parseLeadThread(value, path)
    default: return fail(path, 'unsupported Lead migration version')
  }
}
export const parseLeadSettingsProjection: Validator<LeadSettingsProjection> = object({
  version, model: opaque, key: object({ configured: isBoolean, protection: literalUnion('encrypted', 'unavailable') }),
  policy: parseLeadPermissionPolicy, caps: parseLeadCaps,
})
export const parseLeadHostProjection: Validator<LeadHostProjection> = object({
  version, revision, thread: parseLeadThread, settings: parseLeadSettingsProjection,
})
type ControlOf<T extends LeadChildControl['type']> = Extract<LeadChildControl, { type: T }>
export const parseLeadChildControl: Validator<LeadChildControl> = ipc(tag<LeadChildControl>({
  initialize: object<ControlOf<'initialize'>>({ version, type: literalUnion('initialize'), thread: parseLeadThread, model: opaque, policy: parseLeadPermissionPolicy, budget: parseLeadBudgetState }),
  observe: object<ControlOf<'observe'>>({ version, type: literalUnion('observe'), projection: parseLeadHostProjection }),
  cancel: object<ControlOf<'cancel'>>({ version, type: literalUnion('cancel'), reason: stopReason }),
}))
type EventOf<T extends LeadChildEvent['type']> = Extract<LeadChildEvent, { type: T }>
export const parseLeadChildEvent: Validator<LeadChildEvent> = ipc(tag<LeadChildEvent>({
  ready: object<EventOf<'ready'>>({ version, type: literalUnion('ready') }),
  projection: object<EventOf<'projection'>>({ version, type: literalUnion('projection'), thread: parseLeadThread }),
  stopped: object<EventOf<'stopped'>>({ version, type: literalUnion('stopped'), reason: stopReason }),
}))
export const nextLeadRevision = (current: LeadRevision): LeadRevision => {
  const parsed = revision(current)
  return revision(parsed + 1)
}

export const parseLeadThreadSend: Validator<LeadThreadSend> = object({ idempotencyKey: id, text: prose })
export const parseLeadResume: Validator<{ readonly expectedRevision: number }> = object({ expectedRevision: revision })
export const parseLeadSettingsUpdate: Validator<LeadSettingsUpdate> = object({
  expectedRevision: revision, policy: optional(parseLeadPermissionPolicy), caps: optional(parseLeadCaps),
  credential: optional(object({ provider: (value, path = '') => value === 'anthropic' ? 'anthropic' : fail(path, 'expected Lead credential provider'), key: nullable(text(4096)) })),
})
export const parseLeadEmpty: Validator<Record<string, never>> = object({})

export const parseLeadWindowProjection: Validator<LeadWindowProjection> = ipc(object({
  version, revision, thread: parseLeadThread, settings: parseLeadSettingsProjection, requestInFlight: isBoolean, wayOut: nullable(literalUnion('resume', 'decide-plan')),
  waitReason: nullable(literalUnion(...LEAD_MANAGEMENT_REASONS)), planConsentExpiresAt: nullable(integer(0, Number.MAX_SAFE_INTEGER)),
}))
