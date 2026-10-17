import { CLIENT_METHODS, type ClientMethodName } from './client-surface.js'
import type { CeilingLevel } from './evidence.js'
import { isBoolean, isObject, literalUnion, ValidationError, type Validator } from './validate.js'

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
}
export type LeadCard = (LeadCardBase & { readonly contractDigest: string } & (
  | { readonly type: 'plan'; readonly contract: LeadAcceptanceContract }
  | { readonly type: 'waiting'; readonly kind: 'person' | 'worker-approval'; readonly runId: string;
      readonly personCardId: string | null; readonly summary: string; readonly assertions: readonly LeadAssertionResult[] }
  | { readonly type: 'result'; readonly outcome: 'reviewed' | 'accepted' | 'declined'; readonly summary: string;
      readonly assertions: readonly LeadAssertionResult[]; readonly budget: LeadBudgetState }
  | { readonly type: 'stopped'; readonly reason: LeadStopReason; readonly summary: string; readonly budget: LeadBudgetState }
)) | (LeadCardBase & {
  readonly type: 'permission-change'
  /** Null before there is an approved contract. The immutable card ID/revision binds the policy pair. */
  readonly contractDigest: string | null
  readonly previous: LeadPermissionPolicy
  readonly proposed: LeadPermissionPolicy
})
/** Private recipe choices: person/result acceptance maps accept/decline to accepted/declined. */
export const LEAD_CARD_CHOICES = {
  plan: ['approve', 'decline'], 'permission-change': ['approve', 'decline'],
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
  typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max
    ? value : fail(path, `expected safe integer in ${min}..${max}`)
const revision = integer()
const micros = integer(0, LEAD_LIMITS.maxUsdMicros)
const version: Validator<1> = (value, path = '') => value === LEAD_VERSION ? LEAD_VERSION : fail(path, 'unsupported Lead version')
const boundedText = (max: number, allowEmpty: boolean, controls: RegExp): Validator<string> => (value, path = '') =>
  typeof value === 'string' && (allowEmpty || value.trim().length > 0) && value.length <= max && !controls.test(value)
    ? value : fail(path, `expected ${allowEmpty ? '' : 'nonempty '}string of at most ${max} characters without controls`)
const text = (max: number) => boundedText(max, false, /[\u0000-\u001f\u007f-\u009f]/)
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
const project: Validator<LeadProject> = object({ id, path: projectPath })
const assignment: Validator<LeadAssignment> = object({ role: id, agent: id, seat: id, ceiling: literalUnion('read', 'edit', 'publish', 'merge') })
const step: Validator<LeadPlanStep> = object({
  id, title: prose, flow: id, sourceRevision: id, variables, attendance: literalUnion('attended', 'unattended'),
  assignments: list(assignment, LEAD_LIMITS.assignments, 1, assignment => assignment.role),
})
const assertion: Validator<LeadAssertion> = object({ id, kind: literalUnion('check', 'review', 'blocking-findings', 'diff'), description: prose })
export const parseLeadAcceptanceContract: Validator<LeadAcceptanceContract> = object({
  version, revision, digest, goal: prose, project, policyRevision: revision,
  steps: list(step, LEAD_LIMITS.steps, 1, step => step.id), assertions: list(assertion, LEAD_LIMITS.assertions, 1, assertion => assertion.id), caps: parseLeadCaps,
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
  version, revision, mode: literalUnion('plan', 'default', 'manage'), rules: list(rule, LEAD_LIMITS.rules, 0, rule => rule.id),
})
const stopReason = literalUnion('budget', 'rounds', 'unknown-spend', 'cancelled', 'connection-lost', 'recovery', 'error')
const budgetState: Validator<LeadBudgetState> = object({
  version, revision, caps: parseLeadCaps, leadUsdMicros: micros, workerUsdMicros: micros, reservedUsdMicros: micros,
  roundsAdmitted: integer(0, LEAD_LIMITS.rounds), spend: literalUnion('known', 'unknown', 'stale', 'partial'),
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
    reported >= parsed.caps.usdMicros || reported + parsed.reservedUsdMicros > parsed.caps.usdMicros))
    fail(path, 'budget above allowance requires a stop latch')
  return parsed
}
const cardBase = { version, id, revision, contractDigest: digest }
type CardOf<T extends LeadCard['type']> = Extract<LeadCard, { type: T }>
const card = tag<LeadCard>({
  plan: object<CardOf<'plan'>>({ ...cardBase, type: literalUnion('plan'), contract: parseLeadAcceptanceContract }),
  'permission-change': object<CardOf<'permission-change'>>({ ...cardBase, contractDigest: nullable(digest), type: literalUnion('permission-change'), previous: parseLeadPermissionPolicy, proposed: parseLeadPermissionPolicy }),
  waiting: object<CardOf<'waiting'>>({ ...cardBase, type: literalUnion('waiting'), kind: literalUnion('person', 'worker-approval'), runId: id,
    personCardId: nullable(id), summary: content, assertions: list(parseLeadAssertionResult, LEAD_LIMITS.assertions, 0, result => result.assertionId) }),
  result: object<CardOf<'result'>>({ ...cardBase, type: literalUnion('result'), outcome: literalUnion('reviewed', 'accepted', 'declined'),
    summary: content, assertions: list(parseLeadAssertionResult, LEAD_LIMITS.assertions, 0, result => result.assertionId), budget: parseLeadBudgetState }),
  stopped: object<CardOf<'stopped'>>({ ...cardBase, type: literalUnion('stopped'), reason: stopReason, summary: content, budget: parseLeadBudgetState }),
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
  return parsed
}
const decision: Validator<LeadCardDecision> = object({
  version, cardId: id, cardType: literalUnion('plan', 'permission-change', 'waiting', 'result'),
  expectedRevision: revision, contractDigest: nullable(digest), choice: literalUnion('approve', 'decline', 'accept'),
})
export const parseLeadCardDecision: Validator<LeadCardDecision> = (value, path = '') => {
  const parsed = decision(value, path)
  if (!(LEAD_CARD_CHOICES[parsed.cardType] as readonly string[]).includes(parsed.choice)) fail(path, 'choice is not allowed for this card type')
  if (parsed.cardType !== 'permission-change' && parsed.contractDigest === null) fail(path, 'decision requires a contract digest')
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
const message: Validator<LeadMessage> = object({ version, id, revision, role: literalUnion('user', 'assistant', 'system'), text: content })
export const parseLeadThread: Validator<LeadThread> = object({
  version, id, revision, state: literalUnion('draft', 'planning', 'awaiting-plan', 'running', 'waiting-for-user', 'accepted', 'declined', 'stopped'),
  // One current snapshot per card. Revisions belong to each card, so different cards may
  // share revision 1; the state machine must compare old/new revisions when replacing a card.
  project: nullable(project), olderMessages: integer(),
  messages: list(message, LEAD_LIMITS.messages, 0, message => message.id), cards: list(parseLeadCard, LEAD_LIMITS.cards, 0, card => card.id),
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
  version, model: id, key: object({ configured: isBoolean, protection: literalUnion('encrypted', 'unavailable') }),
  policy: parseLeadPermissionPolicy, caps: parseLeadCaps,
})
export const parseLeadHostProjection: Validator<LeadHostProjection> = object({
  version, revision, thread: parseLeadThread, settings: parseLeadSettingsProjection,
})
type ControlOf<T extends LeadChildControl['type']> = Extract<LeadChildControl, { type: T }>
export const parseLeadChildControl: Validator<LeadChildControl> = ipc(tag<LeadChildControl>({
  initialize: object<ControlOf<'initialize'>>({ version, type: literalUnion('initialize'), thread: parseLeadThread, model: id, policy: parseLeadPermissionPolicy, budget: parseLeadBudgetState }),
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
