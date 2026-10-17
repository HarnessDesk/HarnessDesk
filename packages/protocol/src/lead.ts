import { CLIENT_METHODS, type ClientMethodName } from './client-surface.js'
import type { CeilingLevel } from './evidence.js'
import { isBoolean, isObject, literalUnion, ValidationError, type Validator } from './validate.js'

/** Versioned plain data only. Provider credentials and transport descriptors are private to the child bootstrap. */
export const LEAD_VERSION = 1
export const LEAD_LIMITS = {
  idChars: 256, textChars: 16_384, pathChars: 4_096,
  steps: 64, assignments: 64, assertions: 128, evidence: 128,
  rules: 128, variables: 64, messages: 256, cards: 64, rounds: 100,
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
  readonly seat: string
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
  readonly spend: 'known' | 'unknown' | 'stale' | 'partial'
  /** Durable latch; a higher cap alone does not clear it. */
  readonly stop: { readonly reason: LeadStopReason; readonly revision: LeadRevision } | null
}
interface LeadCardBase {
  readonly version: 1
  readonly id: string
  readonly revision: LeadRevision
  readonly contractDigest: string
}
export type LeadCard = LeadCardBase & (
  | { readonly type: 'plan'; readonly contract: LeadAcceptanceContract }
  | { readonly type: 'permission-change'; readonly previous: LeadPermissionPolicy; readonly proposed: LeadPermissionPolicy }
  | { readonly type: 'waiting'; readonly kind: 'person' | 'worker-approval'; readonly runId: string;
      readonly personCardId: string | null; readonly summary: string; readonly assertions: readonly LeadAssertionResult[] }
  | { readonly type: 'result'; readonly outcome: 'reviewed' | 'accepted' | 'declined'; readonly summary: string;
      readonly assertions: readonly LeadAssertionResult[]; readonly budget: LeadBudgetState }
  | { readonly type: 'stopped'; readonly reason: LeadStopReason; readonly summary: string; readonly budget: LeadBudgetState }
)
/** Authenticated window input only. Never a child command or a worker approval answer. */
export interface LeadCardDecision {
  readonly version: 1
  readonly cardId: string
  readonly expectedRevision: LeadRevision
  readonly contractDigest: string
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
export interface LeadThread {
  readonly version: 1
  readonly id: string
  readonly revision: LeadRevision
  readonly state: LeadThreadState
  readonly project: LeadProject | null
  readonly messages: readonly LeadMessage[]
  readonly cards: readonly LeadCard[]
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
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value : fail(path, `expected safe integer in ${min}..${max}`)
const revision = integer()
const micros = integer()
const version: Validator<1> = (value, path = '') => value === LEAD_VERSION ? LEAD_VERSION : fail(path, 'unsupported Lead version')
const text = (max: number): Validator<string> => (value, path = '') =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0')
    ? value : fail(path, `expected nonempty string of at most ${max} characters`)
const id = text(LEAD_LIMITS.idChars)
const prose = text(LEAD_LIMITS.textChars)
const digest: Validator<string> = (value, path = '') =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail(path, 'expected SHA-256 digest')
const nullable = <T>(parse: Validator<T>): Validator<T | null> => (value, path) => value === null ? null : parse(value, path)
const list = <T>(parse: Validator<T>, max: number, min = 0): Validator<readonly T[]> => (value, path = '') => {
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail(path, `expected ${min}..${max} entries`)
  return value.map((item, index) => parse(item, `${path}[${index}]`))
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
const variables: Validator<Readonly<Record<string, string>>> = (value, path = '') => {
  const entries = Object.entries(isObject(value, path))
  if (entries.length > LEAD_LIMITS.variables) return fail(path, 'too many variables')
  return Object.fromEntries(entries.map(([key, value]) => [id(key, path), prose(value, `${path}.${key}`)]))
}
export const parseLeadCaps: Validator<LeadCaps> = object({ usdMicros: micros, rounds: integer(1, LEAD_LIMITS.rounds) })
const project: Validator<LeadProject> = object({ id, path: text(LEAD_LIMITS.pathChars) })
const assignment: Validator<LeadAssignment> = object({ role: id, agent: id, seat: id, ceiling: literalUnion('read', 'edit', 'publish', 'merge') })
const step: Validator<LeadPlanStep> = object({
  id, title: prose, flow: id, sourceRevision: id, variables, attendance: literalUnion('attended', 'unattended'),
  assignments: list(assignment, LEAD_LIMITS.assignments, 1),
})
const assertion: Validator<LeadAssertion> = object({ id, kind: literalUnion('check', 'review', 'blocking-findings', 'diff'), description: prose })
export const parseLeadAcceptanceContract: Validator<LeadAcceptanceContract> = object({
  version, revision, digest, goal: prose, project, policyRevision: revision,
  steps: list(step, LEAD_LIMITS.steps, 1), assertions: list(assertion, LEAD_LIMITS.assertions, 1), caps: parseLeadCaps,
})
const evidence: Validator<LeadEvidenceReference> = object({ kind: literalUnion('check', 'review', 'finding', 'diff', 'spend'), id, revision: id })
export const parseLeadAssertionResult: Validator<LeadAssertionResult> = object({
  assertionId: id, status: literalUnion('pending', 'passed', 'failed', 'unknown'), revision,
  contractRevision: revision, evidence: list(evidence, LEAD_LIMITS.evidence), reason: nullable(prose),
})
const method: Validator<ClientMethodName> = (value, path = '') =>
  typeof value === 'string' && Object.hasOwn(CLIENT_METHODS, value) ? value as ClientMethodName : fail(path, 'method outside client surface')
const rule: Validator<LeadPermissionRule> = object({
  id, effect: literalUnion('allow', 'ask', 'deny'), method, action: nullable(id), project: nullable(id),
})
export const parseLeadPermissionPolicy: Validator<LeadPermissionPolicy> = object({
  version, revision, mode: literalUnion('plan', 'default', 'manage'), rules: list(rule, LEAD_LIMITS.rules),
})
const stopReason = literalUnion('budget', 'rounds', 'unknown-spend', 'cancelled', 'connection-lost', 'recovery', 'error')
export const parseLeadBudgetState: Validator<LeadBudgetState> = object({
  version, revision, caps: parseLeadCaps, leadUsdMicros: micros, workerUsdMicros: micros, reservedUsdMicros: micros,
  roundsAdmitted: integer(), spend: literalUnion('known', 'unknown', 'stale', 'partial'),
  stop: nullable(object({ reason: stopReason, revision })),
})
const cardBase = { version, id, revision, contractDigest: digest }
type CardOf<T extends LeadCard['type']> = Extract<LeadCard, { type: T }>
const card = tag<LeadCard>({
  plan: object<CardOf<'plan'>>({ ...cardBase, type: literalUnion('plan'), contract: parseLeadAcceptanceContract }),
  'permission-change': object<CardOf<'permission-change'>>({ ...cardBase, type: literalUnion('permission-change'), previous: parseLeadPermissionPolicy, proposed: parseLeadPermissionPolicy }),
  waiting: object<CardOf<'waiting'>>({ ...cardBase, type: literalUnion('waiting'), kind: literalUnion('person', 'worker-approval'), runId: id,
    personCardId: nullable(id), summary: prose, assertions: list(parseLeadAssertionResult, LEAD_LIMITS.assertions) }),
  result: object<CardOf<'result'>>({ ...cardBase, type: literalUnion('result'), outcome: literalUnion('reviewed', 'accepted', 'declined'),
    summary: prose, assertions: list(parseLeadAssertionResult, LEAD_LIMITS.assertions), budget: parseLeadBudgetState }),
  stopped: object<CardOf<'stopped'>>({ ...cardBase, type: literalUnion('stopped'), reason: stopReason, summary: prose, budget: parseLeadBudgetState }),
})
export const parseLeadCard: Validator<LeadCard> = (value, path = '') => {
  const parsed = card(value, path)
  if (parsed.type === 'plan' && parsed.contractDigest !== parsed.contract.digest) fail(path, 'plan card digest differs from contract')
  if (parsed.type === 'waiting' && parsed.kind === 'worker-approval' && parsed.personCardId !== null) fail(path, 'worker approval cannot be a person decision')
  return parsed
}
export const parseLeadCardDecision: Validator<LeadCardDecision> = object({
  version, cardId: id, expectedRevision: revision, contractDigest: digest, choice: literalUnion('approve', 'decline', 'accept'),
})
const message: Validator<LeadMessage> = object({ version, id, revision, role: literalUnion('user', 'assistant', 'system'), text: prose })
export const parseLeadThread: Validator<LeadThread> = object({
  version, id, revision, state: literalUnion('draft', 'planning', 'awaiting-plan', 'running', 'waiting-for-user', 'accepted', 'declined', 'stopped'),
  project: nullable(project), messages: list(message, LEAD_LIMITS.messages), cards: list(parseLeadCard, LEAD_LIMITS.cards),
})
export const parseLeadSettingsProjection: Validator<LeadSettingsProjection> = object({
  version, model: id, key: object({ configured: isBoolean, protection: literalUnion('encrypted', 'unavailable') }),
  policy: parseLeadPermissionPolicy, caps: parseLeadCaps,
})
export const parseLeadHostProjection: Validator<LeadHostProjection> = object({
  version, revision, thread: parseLeadThread, settings: parseLeadSettingsProjection,
})
type ControlOf<T extends LeadChildControl['type']> = Extract<LeadChildControl, { type: T }>
export const parseLeadChildControl: Validator<LeadChildControl> = tag<LeadChildControl>({
  initialize: object<ControlOf<'initialize'>>({ version, type: literalUnion('initialize'), thread: parseLeadThread, model: id, policy: parseLeadPermissionPolicy, budget: parseLeadBudgetState }),
  observe: object<ControlOf<'observe'>>({ version, type: literalUnion('observe'), projection: parseLeadHostProjection }),
  cancel: object<ControlOf<'cancel'>>({ version, type: literalUnion('cancel'), reason: stopReason }),
})
type EventOf<T extends LeadChildEvent['type']> = Extract<LeadChildEvent, { type: T }>
export const parseLeadChildEvent: Validator<LeadChildEvent> = tag<LeadChildEvent>({
  ready: object<EventOf<'ready'>>({ version, type: literalUnion('ready') }),
  projection: object<EventOf<'projection'>>({ version, type: literalUnion('projection'), thread: parseLeadThread }),
  stopped: object<EventOf<'stopped'>>({ version, type: literalUnion('stopped'), reason: stopReason }),
})
export const nextLeadRevision = (current: LeadRevision): LeadRevision => {
  const parsed = revision(current)
  return revision(parsed + 1)
}
