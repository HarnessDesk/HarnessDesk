import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  TRIGGER_DECISIONS_KEPT, TRIGGER_THREADS_KEPT,
  type PhoneTriageRow, type PhoneUnconfirmedStop, type TriggerDecision, type TriggerDecisionsPage, type TriggerDefinition, type TriggerFact, type TriggerMode,
  type TriggerRuleCheck, type TriggerStopProgress, type TriggerTriage, type TriggerUnconfirmedStop, type TriggerWorkThread,
} from '@harnessdesk/protocol'

import { Serial } from '../goals/assignments.js'
import { atomicJson, GOAL_DOCUMENT_LIMIT } from '../goals/store.js'
import { leadContainsSecret } from '../lead/secrets.js'
import type { OfferAnswer } from './admission.js'
import type { ArmedTrigger } from './consent.js'
import type { MentionThread } from './forge.js'
import { FIRING_LIMIT } from './store.js'

/**
 * Mentions: a comment on the forge that addresses the desk by its handle asks
 * it for work.
 *
 * What it reads is untrusted all the way through. A comment is matched on
 * `@handle` in its own words only — never inside code, a quote, or another
 * word. Deterministic rules decide first, in order — addressed, allowed,
 * project, label, handled, stop — and the first that fails ignores it with
 * its own sentence, before anything is sent anywhere. Only then is one
 * assessment asked, and all it can answer is a decision and a sentence:
 * what accepting opens, its budget and its round are the trigger's, fixed
 * when it was armed, and the comment never reaches them. An assessment that
 * cannot be made is a question for the person, never a guess.
 *
 * A trigger observes until a person switches it to act on this machine: an
 * accepted request is recorded as "would have accepted" and nothing else
 * happens. Arming it again — a changed declaration — puts it back to observe.
 *
 * An accepted request that acted is one thread of work: the issue or pull
 * request it started on, every Goal it opened, and every pull request that
 * work opened. A later comment on any of them from someone allowed joins it
 * without a new triage; anyone else's is counted as an observation and acted
 * on never. It closes when every linked pull request merged or closed, or
 * when someone allowed asks it to stop.
 */

const FILE = 'triggers-mentions.json'
/** How many comment ids a thread remembers having taken, so a comment offered twice joins once. */
const THREAD_SEEN = 200
/** How long a thread the work ledger could not take waits before it is offered again. */
const ATTACH_RETRY_MS = 60 * 60_000
const EXCERPT = 280
const REASON = 300
/** At most this many assessments a day on one desk; past it, a request waits for the person. */
export const ASSESSMENTS_PER_DAY = 200

export const ASSESS_UNAVAILABLE = 'The assessment could not be made, so this waits for you.'
export const ASSESS_SECRET = 'This comment looks like it holds a credential, so it was not sent for assessment; it waits for you.'
export const ASSESS_CAPPED = `More than ${ASSESSMENTS_PER_DAY} requests were assessed today, so this one waits for you.`
const STOPPED = 'Stopped from the forge: someone allowed asked the work on this thread to stop.'
/** How long who-may-ask answers from the forge are reused: a burst of comments reads each account once. */
export const ACCOUNT_TTL_MS = 5 * 60_000
export const EDITED = 'This comment was edited after it was first read, so it is not evaluated again: the request a person would approve is not the one recorded.'

// ----------------------------------------------------------------- reading

const FENCE = /(^|\n)[ \t]*(```|~~~)[\s\S]*?(\n[ \t]*\2[^\n]*|$)/g
const INLINE = /`[^`\n]*`/g
const QUOTE = /^[ \t]*>.*$/gm
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A comment's own words: fenced code, inline code and quoted lines taken out. */
const ownWords = (body: string): string => body.replace(FENCE, '\n').replace(INLINE, ' ').replace(QUOTE, '')

/** Whether a comment addresses `@handle` in its own words: not in code, not in a quote, not as part of another word or address. */
export const addressesHandle = (body: string, handle: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9_.@/+-])@${escape(handle)}(?![A-Za-z0-9_-])`, 'i').test(ownWords(body))

/** Whether it asks `@handle` to stop or cancel, as the words right after the handle. */
export const asksToStop = (body: string, handle: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9_.@/+-])@${escape(handle)}[\\s,:]+(?:stop|cancel)\\b`, 'i').test(ownWords(body))

const TRIAGES: ReadonlySet<string> = new Set(['accept', 'ignore', 'stop', 'ask'])

export interface MentionAssessment {
  readonly decision: TriggerTriage
  readonly reason: string
}

/**
 * An assessment's answer: one decision and one short sentence, from the
 * first JSON object in the text. Every other field is dropped; anything
 * that is not exactly that is no answer.
 */
export const parseAssessment = (text: string): MentionAssessment | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { decision, reason } = value as Record<string, unknown>
  if (typeof decision !== 'string' || !TRIAGES.has(decision)) return null
  if (typeof reason !== 'string') return null
  const clean = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (!clean) return null
  return { decision: decision as TriggerTriage, reason: clean.length > REASON ? `${clean.slice(0, REASON - 1)}…` : clean }
}

/** What one assessment is shown: the comment as data, and what accepting would open, told rather than asked. */
export interface MentionAssessInput {
  readonly trigger: { readonly id: string; readonly handle: string; readonly opens: string }
  readonly repository: string
  readonly thread: { readonly kind: 'issue' | 'pull-request'; readonly number: number; readonly title: string }
  readonly comment: { readonly author: string | null; readonly body: string }
}

/** The observer model, behind one call. Null, or a throw, is "could not be made". */
export type MentionAssessor = (input: MentionAssessInput, signal: AbortSignal) => Promise<MentionAssessment | null>

/**
 * Where an accepted thread of work joins the Lead's work ledger: the thread it
 * came from (repository, number and the comment that asked) and the work it
 * opened. Work the Lead starts later for the same thread, after a person
 * approves its plan, joins the same item, so the board shows them as one. The
 * item is for reading: a stop on the thread never walks it, since every
 * thread on the same issue shares it. With no Lead on the desk there is no
 * ledger, and the thread's own record is the only linkage.
 */
export interface WorkItemsPort {
  /** The item the thread is on now; null when the desk keeps no work ledger. */
  attach(origin: { readonly kind: 'mention'; readonly trigger: string; readonly repository: string; readonly thread: TriggerWorkThread['origin']; readonly comment: string | null }, links: TriggerWorkThread['links']): Promise<string | null>
}

export const NO_WORK_ITEMS: WorkItemsPort = { attach: async () => null }

const opensWords = (definition: TriggerDefinition): string =>
  'flow' in definition.opens ? `the flow ${definition.opens.flow}` : 'agent' in definition.opens ? `the Agent ${definition.opens.agent}` : 'the Lead'

const threadWords = (kind: 'issue' | 'pull-request', number: number): string =>
  `${kind === 'pull-request' ? 'Pull request' : 'Issue'} #${number}`

const listWords = (items: readonly string[]): string =>
  items.length <= 1 ? items.join('') : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`

const allowedWords = (definition: TriggerDefinition): string => listWords([
  definition.from === 'collaborators' ? 'the arming account and people who can write to the repository' : 'the arming account',
  ...(definition.people ?? []),
  ...(definition.bots ?? []).map((bot) => `the bot ${bot}`),
])

const commentId = (url: string): string => /#issuecomment-([1-9][0-9]{0,18})$/.exec(url)?.[1] ?? ''

/** The excerpt kept and shown: blank when the comment holds a credential, so it is never stored or sent to the phone. */
const excerptOf = (body: string): string => {
  if (leadContainsSecret(body)) return ''
  const flat = body.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat
}

const digest = (parts: readonly string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20)
/** What the comment said when it was decided, by digest: Re-evaluate refuses one edited since. */
const bodyDigest = (body: string): string => createHash('sha256').update(body).digest('hex')

// ------------------------------------------------------------------ ledger

interface StoredThread extends TriggerWorkThread {
  /** The issue is closed even when active work keeps the thread followable. */
  readonly issueClosed?: boolean
  /** Admission keys of every firing it took: what the Lead's own pull request is found by. */
  readonly firings: readonly string[]
  /** Comment ids it already took or counted. */
  readonly seen: readonly string[]
  /** The comment that asked for the work, by URL. */
  readonly comment?: string
  /** The Lead's work item it is on, once the desk keeps one. */
  readonly workItem?: string
}

/** The public thread may be evicted; keep its lifetime IDs while these exact firings remain pending. */
interface PendingThread extends StoredThread { readonly pendingFirings: readonly string[] }

/** A decision as the desk keeps it: with the digest of the comment it decided, never shown. */
interface StoredDecision extends TriggerDecision {
  readonly commentDigest?: string
  /** A host refusal record, not a comment to re-evaluate. */
  readonly closedFiring?: string
}

/** Private durable authority for one comment, including the original scope and exact receipts. */
interface StopIntent {
  readonly version: 1
  readonly id: string
  readonly key: { readonly project: string; readonly trigger: string; readonly repository: string; readonly comment: string }
  readonly bodyDigest: string
  readonly threadId: string
  readonly thread: TriggerDecision['thread']
  readonly author: string | null
  readonly excerpt: string
  readonly url: string
  readonly createdAt: number
  readonly state: 'inFlight' | 'unconfirmed' | 'reviewed' | 'consumed'
  readonly decisionId: string | null
  readonly goals: readonly string[]
  readonly firings: readonly string[]
  readonly queuedTargets: readonly string[]
  readonly runTargets: readonly string[]
  readonly interruptTargets: readonly string[]
  readonly leadRunTargets: readonly string[]
  readonly leadPlanTarget: string | null
  readonly receipts: { readonly queued: readonly string[]; readonly runs: readonly string[]; readonly interrupts: readonly string[];
    readonly leadRuns: readonly string[]; readonly leadPlan: boolean }
}

interface LedgerFile {
  readonly version: 1 | 2
  readonly decisions: readonly StoredDecision[]
  readonly threads: readonly StoredThread[]
  /** Authority retained only while one of these exact firings is pending. */
  readonly pendingThreads: readonly PendingThread[]
  readonly stopIntents: readonly StopIntent[]
  readonly modes: Readonly<Record<string, { readonly mode: TriggerMode; readonly armedAt: number }>>
  readonly assessed: { readonly day: string; readonly count: number }
}

const EMPTY: LedgerFile = { version: 1, decisions: [], threads: [], pendingThreads: [], stopIntents: [], modes: {}, assessed: { day: '', count: 0 } }

const isMap = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const stopKey = (key: StopIntent['key']): string => JSON.stringify([key.project, key.trigger, key.repository, key.comment])
const stopId = (key: StopIntent['key']): string => `u-${createHash('sha256').update(stopKey(key)).digest('hex')}`
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const boundedIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= FIRING_LIMIT &&
  value.every(one => boundedText(one, 4096)) && new Set(value).size === value.length
const queuedTargetKey = (value: string, project: string, trigger: string): string | null => {
  try {
    const target: unknown = JSON.parse(value)
    if (!Array.isArray(target) || target.length !== 8 || !/^[0-9a-f]{64}$/.test(String(target[0])) ||
      !Number.isSafeInteger(target[1]) || target[1] < 0 || target[2] !== project || target[3] !== trigger ||
      !boundedText(target[4], 4096) || !boundedText(target[5], 4096) || !['start', 'again', 'record'].includes(target[6]) ||
      !Number.isSafeInteger(target[7]) || target[7] < 0 || JSON.stringify(target) !== value) return null
    return target[0]
  } catch { return null }
}
const safeStopUrl = (value: unknown): value is string => {
  if (!boundedText(value, 2048)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !leadContainsSecret(value)
  } catch { return false }
}

const isStopIntent = (value: unknown): value is StopIntent => {
  if (!isMap(value) || !exactKeys(value, ['version', 'id', 'key', 'bodyDigest', 'threadId', 'thread', 'author', 'excerpt', 'url', 'createdAt', 'state', 'decisionId', 'goals', 'firings', 'queuedTargets', 'runTargets', 'interruptTargets', 'leadRunTargets', 'leadPlanTarget', 'receipts']) ||
    value.version !== 1 || !isMap(value.key) || !exactKeys(value.key, ['project', 'trigger', 'repository', 'comment']) ||
    !boundedText(value.key.project, 4096) || !boundedText(value.key.trigger, 256) || !boundedText(value.key.repository, 512) ||
    typeof value.key.comment !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value.key.comment) ||
    value.key.repository !== value.key.repository.toLowerCase() || value.id !== stopId(value.key as unknown as StopIntent['key']) || typeof value.bodyDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.bodyDigest) ||
    !boundedText(value.threadId, 256) || !isMap(value.thread) || !exactKeys(value.thread, ['kind', 'number']) ||
    !['issue', 'pull-request'].includes(String(value.thread.kind)) || !Number.isSafeInteger(value.thread.number) || (value.thread.number as number) < 1 ||
    !(value.author === null || boundedText(value.author, 256) && !leadContainsSecret(value.author)) || typeof value.excerpt !== 'string' || value.excerpt.length > EXCERPT ||
    leadContainsSecret(value.excerpt) || !safeStopUrl(value.url) || commentId(value.url) !== value.key.comment ||
    !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0 ||
    !['inFlight', 'unconfirmed', 'reviewed', 'consumed'].includes(String(value.state)) ||
    !(value.decisionId === null || boundedText(value.decisionId, 256)) || (value.state === 'consumed') !== (value.decisionId !== null) ||
    !boundedIds(value.goals) || !boundedIds(value.firings) || !boundedIds(value.queuedTargets) || !boundedIds(value.runTargets) || !boundedIds(value.interruptTargets) || !boundedIds(value.leadRunTargets) ||
    !(value.leadPlanTarget === null || boundedText(value.leadPlanTarget, 4096)) ||
    !isMap(value.receipts) || !exactKeys(value.receipts, ['queued', 'runs', 'interrupts', 'leadRuns', 'leadPlan']) ||
    !boundedIds(value.receipts.queued) || !boundedIds(value.receipts.runs) || !boundedIds(value.receipts.interrupts) ||
    !boundedIds(value.receipts.leadRuns) || typeof value.receipts.leadPlan !== 'boolean') return false
  const identity = value.key as { project: string; trigger: string }
  return (!value.receipts.leadPlan || value.leadPlanTarget !== null) && (value.queuedTargets as string[]).every(one => {
    const key = queuedTargetKey(one, identity.project, identity.trigger)
    return key !== null && (value.firings as string[]).includes(key)
  }) &&
    value.receipts.queued.every(one => (value.queuedTargets as string[]).includes(one)) &&
    value.receipts.runs.every(one => (value.runTargets as string[]).includes(one)) &&
    value.receipts.interrupts.every(one => (value.interruptTargets as string[]).includes(one)) &&
    value.receipts.leadRuns.every(one => (value.leadRunTargets as string[]).includes(one))
}

/** One protected stop and its ordinary success row occupy one history slot. */
const historySlots = (decisions: readonly StoredDecision[], stops: readonly StopIntent[]): number => {
  const linked = new Set(stops.flatMap(one => one.decisionId ? [one.decisionId] : []))
  return stops.length + decisions.filter(one => !linked.has(one.id)).length
}

const stopProgress = (stop: StopIntent): TriggerStopProgress => ({
  queuedCancelled: stop.receipts.queued.length, runsMarkedStopped: stop.receipts.runs.length,
  interruptRequestsIssued: stop.receipts.interrupts.length, leadRunsMarkedStopped: stop.receipts.leadRuns.length,
  leadPlanStopped: stop.receipts.leadPlan,
})

const publicStop = (stop: StopIntent): TriggerUnconfirmedStop => {
  if (stop.state === 'consumed') throw new Error('A consumed stop is not an uncertainty row.')
  const progress = stopProgress(stop)
  const summary = `${progress.queuedCancelled} queued cancelled; ${progress.runsMarkedStopped} runs marked stopped; ` +
    `${progress.interruptRequestsIssued} interrupt requests issued; ${progress.leadRunsMarkedStopped} Lead runs marked stopped; ` +
    `Lead plan ${progress.leadPlanStopped ? 'marked stopped' : 'not confirmed stopped'}. Check the work before taking further action.`
  return { id: stop.id, trigger: stop.key.trigger, project: stop.key.project, repository: stop.key.repository,
    thread: stop.thread, author: stop.author, excerpt: stop.excerpt, url: stop.url, createdAt: stop.createdAt,
    state: stop.state, progress, summary }
}

/** The file as the host wrote it, or null: what is not exactly that is never trusted, and never overwritten. */
const ledgerOf = (value: unknown): LedgerFile | null => {
  if (!isMap(value) || (value['version'] !== 1 && value['version'] !== 2) || !Array.isArray(value['decisions']) || !Array.isArray(value['threads']) || !isMap(value['modes']) || !isMap(value['assessed'])) return null
  const decisions = value['decisions'].filter((one): one is StoredDecision =>
    isMap(one) && typeof one['id'] === 'string' && typeof one['trigger'] === 'string' && typeof one['project'] === 'string' && TRIAGES.has(String(one['decision'])) &&
    isMap(one['comment']) && isMap(one['thread']) && Array.isArray(one['rules']))
  const storedStops = value['stopIntents'] ?? []
  if (!Array.isArray(storedStops) || storedStops.length > TRIGGER_DECISIONS_KEPT ||
    Buffer.byteLength(JSON.stringify(storedStops)) > GOAL_DOCUMENT_LIMIT || !storedStops.every(isStopIntent) ||
    storedStops.some(one => Buffer.byteLength(JSON.stringify(one)) > 1024 * 1024)) return null
  const stopIntents = storedStops as StopIntent[]
  if (value['version'] === 1 && stopIntents.length > 0) return null
  if (new Set(stopIntents.map(one => stopKey(one.key))).size !== stopIntents.length ||
    new Set(stopIntents.map(one => one.id)).size !== stopIntents.length ||
    new Set(stopIntents.flatMap(one => one.decisionId ? [one.decisionId] : [])).size !== stopIntents.filter(one => one.decisionId).length ||
    historySlots(decisions, stopIntents) > TRIGGER_DECISIONS_KEPT) return null
  for (const stop of stopIntents) {
    const decision = decisions.find(one => one.id === stop.decisionId)
    if (decision && (decision.decision !== 'stop' || decision.project !== stop.key.project || decision.trigger !== stop.key.trigger ||
      decision.repository.toLowerCase() !== stop.key.repository || decision.comment.id !== stop.key.comment)) return null
  }
  const isThread = (one: unknown): one is StoredThread =>
    isMap(one) && typeof one['id'] === 'string' && isMap(one['links']) && Array.isArray(one['firings']) && Array.isArray(one['seen']) && isMap(one['origin'])
  if (value['threads'].some(one => isMap(one) && one['issueClosed'] !== undefined && typeof one['issueClosed'] !== 'boolean')) return null
  const threads = value['threads'].filter(isThread)
  const pending = value['pendingThreads']
  if (Array.isArray(pending) && pending.some(one => isMap(one) && one['issueClosed'] !== undefined && typeof one['issueClosed'] !== 'boolean')) return null
  const isPendingThread = (one: unknown): one is PendingThread => {
    if (!isThread(one) || typeof one.project !== 'string' || typeof one.trigger !== 'string' || typeof one.repository !== 'string' ||
      !['open', 'closed'].includes(one.state) || !['issue', 'pull-request'].includes(one.origin.kind) ||
      !Number.isSafeInteger(one.origin.number) || one.origin.number < 1 || !Array.isArray(one.links.issues) ||
      !Array.isArray(one.links.pulls) || !Array.isArray(one.links.goals) || !one.firings.length || one.firings.length > FIRING_LIMIT ||
      one.seen.length > THREAD_SEEN || !one.seen.every(id => typeof id === 'string') ||
      !Array.isArray((one as PendingThread).pendingFirings) || !(one as PendingThread).pendingFirings.length) return false
    const numbers = (items: readonly number[]) => items.every(item => Number.isSafeInteger(item) && item > 0)
    return numbers(one.links.issues) && numbers(one.links.pulls) && one.links.goals.every(goal => typeof goal === 'string') &&
      one.firings.every(key => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)) &&
      (one as PendingThread).pendingFirings.every(key => one.firings.includes(key)) &&
      (one.origin.kind === 'issue' ? one.links.issues.includes(one.origin.number) : one.links.pulls.includes(one.origin.number)) &&
      (one.state === 'open' ? one.closed === null : one.closed !== null && isMap(one.closed))
  }
  if (pending !== undefined && (!Array.isArray(pending) || pending.length > FIRING_LIMIT || !pending.every(isPendingThread))) return null
  const pendingThreads = (pending ?? []) as PendingThread[]
  const keys = pendingThreads.flatMap(one => one.pendingFirings)
  const lifetime = pendingThreads.flatMap(one => one.firings)
  if (keys.length > FIRING_LIMIT || new Set(keys).size !== keys.length || lifetime.length > FIRING_LIMIT || new Set(lifetime).size !== lifetime.length) return null
  const modes: Record<string, { mode: TriggerMode; armedAt: number }> = {}
  for (const [key, entry] of Object.entries(value['modes'])) {
    if (isMap(entry) && (entry['mode'] === 'act' || entry['mode'] === 'observe') && Number.isSafeInteger(entry['armedAt'])) modes[key] = { mode: entry['mode'], armedAt: entry['armedAt'] as number }
  }
  const assessed = value['assessed']
  return {
    version: value['version'] as 1 | 2, decisions, threads, pendingThreads, stopIntents, modes,
    assessed: typeof assessed['day'] === 'string' && Number.isSafeInteger(assessed['count']) ? { day: assessed['day'], count: assessed['count'] as number } : EMPTY.assessed,
  }
}

const modeKey = (project: string, trigger: string): string => `${project}\u0000${trigger}`

// -------------------------------------------------------------------- port

/** Opaque exact operation targets captured before the first effect. */
export interface MentionStopPlan {
  readonly queuedTargets: readonly string[]
  readonly runTargets: readonly string[]
  readonly interruptTargets: readonly string[]
  readonly leadRunTargets: readonly string[]
  readonly leadPlanTarget: string | null
}
export type MentionStopReceipt = { readonly kind: 'queued' | 'run' | 'interrupt' | 'leadRun'; readonly target: string } |
  { readonly kind: 'leadPlan'; readonly target: string }

export interface MentionPort {
  /** The desk's state folder. */
  readonly home: string
  readonly forge: {
    isAccount(project: string, login: string, bot: boolean, author: string, signal: AbortSignal): Promise<boolean>
    writes(project: string, repository: string, login: string, author: string, signal: AbortSignal): Promise<boolean>
    thread(project: string, repository: string, number: number, signal: AbortSignal): Promise<MentionThread>
    pullState(project: string, repository: string, number: number, signal: AbortSignal): Promise<'open' | 'merged' | 'closed'>
    comment(project: string, repository: string, id: number, signal: AbortSignal): Promise<TriggerFact>
  }
  /** The observer model; null when none can be asked on this desk. */
  readonly assess: MentionAssessor | null
  /** The handle a trigger without one answers to: the desk's Lead name. */
  leadName(): string
  /**
   * Stops a thread's work through the host, with the reason: the trigger's own runs on its Goals, and the Lead's goal
   * when one of the thread's firings opened it, as the person's Stop stops it and recorded as a stop from `comment`.
   * How many runs of each it stopped, and whether the Lead's plan was stopped.
   */
  stop(work: { readonly goals: readonly string[]; readonly firings: readonly string[]; readonly comment: string }, why: string): Promise<{ readonly own: number; readonly lead: number; readonly plan: boolean; readonly queued: number }>
  /** Planning is read-only; every exact target is durably frozen before stopOnce runs. */
  planStop?(work: { readonly goals: readonly string[]; readonly firings: readonly string[]; readonly comment: string }): Promise<MentionStopPlan>
  /** The one-shot path must await each receipt before beginning the next effect. */
  stopOnce?(work: { readonly goals: readonly string[]; readonly firings: readonly string[]; readonly comment: string }, why: string,
    plan: MentionStopPlan, receipt: (value: MentionStopReceipt) => Promise<void>, stop: string): Promise<{ readonly complete: boolean }>
  /** Exact Lead firing keys still pending in the bounded admission journal. */
  pendingFirings(): readonly string[]
  /** Every lifetime firing must still have its durable admission tombstone. */
  knowsFirings(project: string, trigger: string, keys: readonly string[]): boolean
  /** Whether work owned by this thread is still active. */
  activeWork?(goals: readonly string[], firings: readonly string[]): boolean
  /** Existing mention sweep interval: the longest a live observation can authorize retries. */
  readonly observationWindowMs: number
  /** Commit a natural thread closure between admission deliveries. */
  closeThread(close: () => Promise<void>): Promise<void>
  /** The pull requests the work on these Goals and firings opened, by number. */
  pullRequests(repository: string, goals: readonly string[], firings: readonly string[]): Promise<readonly number[]>
  readonly workItems: WorkItemsPort
  /** A decision that waits for the person: said once, by its own key. */
  ask(arm: ArmedTrigger, decision: TriggerDecision): Promise<void>
  /** Something a surface shows of this project's triggers changed. */
  changed(project: string): void
  readonly signal: AbortSignal
  now(): number
  log(message: string, details?: Readonly<Record<string, unknown>>): void
}

type Admit = (arm: ArmedTrigger, fact: TriggerFact) => Promise<OfferAnswer>

interface Verdict {
  readonly decision: TriggerTriage
  readonly reason: string
  readonly by: TriggerDecision['by']
  readonly rules: readonly TriggerRuleCheck[]
}

// ------------------------------------------------------------------ triage

export class MentionTriage {
  readonly #port: MentionPort
  readonly #file: string
  readonly #capacityFile: string
  readonly #serial = new Serial()
  #ledger: LedgerFile | null = null
  #loading: Promise<LedgerFile> | null = null
  #problem: string | null = null
  #capacityAlerts: { readonly all: boolean; readonly triggers: readonly { readonly project: string; readonly trigger: string }[] } = { all: false, triggers: [] }
  /** Who-may-ask answers from the forge, by question, with when they were read. */
  readonly #accounts = new Map<string, { readonly answer: boolean; readonly at: number }>()
  /** Observed-open firings expire at the existing mention sweep interval. */
  readonly #verified = new Map<string, number>()
  #sweepOffset = 0
  /** Threads the work ledger refused, by when to offer them again; and those already said, so each is said once. */
  readonly #attachHeld = new Map<string, number>()
  readonly #attachSaid = new Set<string>()

  constructor(port: MentionPort) {
    this.#port = port
    this.#file = join(port.home, FILE)
    this.#capacityFile = join(port.home, 'triggers-stop-capacity.json')
  }

  /** Why mentions are judged nowhere on this desk now — a decisions file that is not the desk's own — or null. */
  get problem(): string | null { return this.#problem }

  async #read(): Promise<LedgerFile> {
    if (this.#ledger) return this.#ledger
    if (this.#loading) return this.#loading
    const loading = this.#load()
    this.#loading = loading
    try { return await loading } finally { if (this.#loading === loading) this.#loading = null }
  }

  async #load(): Promise<LedgerFile> {
    try {
      const text = await readFile(this.#capacityFile, 'utf8')
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('capacity-limit')
      const value: unknown = JSON.parse(text)
      if (!isMap(value) || !exactKeys(value, ['version', 'all', 'triggers']) || value.version !== 1 || typeof value.all !== 'boolean' ||
        !Array.isArray(value.triggers) || value.triggers.length > TRIGGER_DECISIONS_KEPT || !value.triggers.every(one =>
          isMap(one) && exactKeys(one, ['project', 'trigger']) && boundedText(one.project, 4096) && boundedText(one.trigger, 256))) throw new Error('capacity-invalid')
      const triggers = value.triggers as { project: string; trigger: string }[]
      if (new Set(triggers.map(one => modeKey(one.project, one.trigger))).size !== triggers.length) throw new Error('capacity-duplicate')
      this.#capacityAlerts = { all: value.all, triggers }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#problem = 'Stop history could not be read safely, so mentions wait until a person looks at it.'
        throw error
      }
    }
    let text: string
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#problem = null
        return (this.#ledger = EMPTY)
      }
      throw error
    }
    if (Buffer.byteLength(text) > GOAL_DOCUMENT_LIMIT) {
      this.#problem = 'The mention decisions on this desk could not be read, so mentions wait until a person looks at it.'
      throw new Error(this.#problem)
    }
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch { /* below */ }
    const ledger = ledgerOf(parsed)
    if (!ledger) {
      this.#problem = 'The mention decisions on this desk could not be read, so mentions wait until a person looks at it.'
      throw new Error(this.#problem)
    }
    const recovering = ledger.stopIntents.some(one => one.state === 'inFlight')
    const recovered: LedgerFile = recovering ? { ...ledger, stopIntents: ledger.stopIntents.map(one =>
      one.state === 'inFlight' ? { ...one, state: 'unconfirmed' } : one) } : ledger
    if (recovering) {
      try { await atomicJson(this.#file, recovered) } catch (error) {
        this.#problem = 'A stop could not be recovered safely, so mentions wait until a person looks at it.'
        throw error
      }
    }
    this.#problem = null
    this.#ledger = recovered
    if (recovering) {
      for (const project of new Set(ledger.stopIntents.filter(one => one.state === 'inFlight').map(one => one.key.project))) {
        this.#port.changed(project)
      }
    }
    return recovered
  }

  async #write(next: LedgerFile): Promise<void> {
    const pending = new Set(this.#port.pendingFirings())
    const anchors = new Map<string, PendingThread>()
    // The visible history wins when it is present; an evicted thread's
    // pending-only copy survives until its last pending firing settles.
    for (const thread of [...next.pendingThreads, ...next.threads]) {
      const pendingFirings = thread.firings.filter(key => pending.has(key))
      if (pendingFirings.length) anchors.set(thread.id, { ...thread, pendingFirings })
    }
    const decisions = [...next.decisions]
    const linked = new Set(next.stopIntents.flatMap(one => one.decisionId ? [one.decisionId] : []))
    while (historySlots(decisions, next.stopIntents) > TRIGGER_DECISIONS_KEPT) {
      const index = decisions.findIndex(one => !linked.has(one.id))
      if (index < 0) throw new Error('Stop history is full. Stop work directly before taking further action.')
      decisions.splice(index, 1)
    }
    const trimmed: LedgerFile = {
      ...next,
      version: next.version === 2 || next.stopIntents.length > 0 ? 2 : 1,
      pendingThreads: [...anchors.values()],
      decisions,
      threads: next.threads.length > TRIGGER_THREADS_KEPT
        // Closed ones go first, then the oldest open.
        ? [...next.threads.filter((one) => one.state === 'closed'), ...next.threads.filter((one) => one.state === 'open')].slice(-TRIGGER_THREADS_KEPT)
        : next.threads,
    }
    if (!ledgerOf(trimmed)) throw new Error('The mention decisions could not be saved safely.')
    try { await atomicJson(this.#file, trimmed) } catch (error) {
      // A failed write can be ambiguous at the rename boundary. Re-read and
      // recover from disk before any later effect, never from stale memory.
      this.#ledger = null
      this.#problem = 'The mention decisions could not be saved safely, so mentions wait until a person looks at it.'
      throw error
    }
    this.#ledger = trimmed
  }

  // ---------------------------------------------------------------- mode

  #modeOf(ledger: LedgerFile, arm: ArmedTrigger): TriggerMode {
    const stored = ledger.modes[modeKey(arm.project, arm.id)]
    return stored && stored.armedAt === arm.armedAt ? stored.mode : 'observe'
  }

  /** A trigger's mode on this machine; observe unless a person switched this arm to act. */
  async mode(arm: ArmedTrigger): Promise<TriggerMode> {
    return this.#modeOf(await this.#read(), arm)
  }

  /** An arm made or taken away: the trigger observes again until a person switches it, whatever it did before. */
  reset(project: string, trigger: string): Promise<void> {
    return this.#serial.run(async () => {
      const ledger = await this.#read()
      const key = modeKey(project, trigger)
      if (!(key in ledger.modes)) return
      const { [key]: _gone, ...modes } = ledger.modes
      await this.#write({ ...ledger, modes })
    })
  }

  setMode(arm: ArmedTrigger, mode: TriggerMode): Promise<void> {
    return this.#serial.run(async () => {
      const ledger = await this.#read()
      await this.#write({ ...ledger, modes: { ...ledger.modes, [modeKey(arm.project, arm.id)]: { mode, armedAt: arm.armedAt } } })
      this.#port.changed(arm.project)
    })
  }

  // --------------------------------------------------------------- reads

  /** One trigger's decisions, newest first, its mode for this arm (observe when disarmed), and its threads. */
  async page(project: string, trigger: string, arm: ArmedTrigger | null): Promise<TriggerDecisionsPage> {
    const ledger = await this.#read()
    return {
      mode: arm ? this.#modeOf(ledger, arm) : 'observe',
      decisions: ledger.decisions.filter((one) => one.project === project && one.trigger === trigger).reverse().map(publicDecision),
      threads: ledger.threads.filter((one) => one.project === project && one.trigger === trigger).reverse().map(publicThread),
      unconfirmedStops: ledger.stopIntents.filter(one => one.key.project === project && one.key.trigger === trigger && one.state !== 'consumed')
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).map(publicStop),
      stopHistoryFull: this.#capacityAlerts.all || this.#capacityAlerts.triggers.some(one => one.project === project && one.trigger === trigger) || ledger.stopIntents.length >= TRIGGER_DECISIONS_KEPT,
    }
  }

  /** Discover protected history even after its declaration disappears or changes kind. */
  async retainedStops(project: string, currentMentionIds: readonly string[]) {
    const ledger = await this.#read()
    const current = new Set(currentMentionIds)
    // Keep every protected record reachable first; a surplus of marker-only
    // rows collapses into the project-level capacity attention.
    const ids = new Set(ledger.stopIntents.filter(one => one.key.project === project && one.state !== 'consumed' && !current.has(one.key.trigger)).map(one => one.key.trigger))
    let markersOmitted = false
    for (const marker of this.#capacityAlerts.triggers) {
      if (marker.project !== project || current.has(marker.trigger) || ids.has(marker.trigger)) continue
      if (ids.size >= TRIGGER_DECISIONS_KEPT) markersOmitted = true
      else ids.add(marker.trigger)
    }
    const stopHistoryFull = this.#capacityAlerts.all || markersOmitted || ledger.stopIntents.length >= TRIGGER_DECISIONS_KEPT
    return {
      stopHistoryFull,
      retainedStopTriggers: [...ids].sort().map(id => ({
        id,
        unconfirmedStops: ledger.stopIntents.filter(one => one.key.project === project && one.key.trigger === id && one.state !== 'consumed')
          .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).map(publicStop),
        stopHistoryFull: stopHistoryFull || this.#capacityAlerts.triggers.some(one => one.project === project && one.trigger === id),
      })),
    }
  }

  async phoneStops(limit: number): Promise<{ readonly unconfirmedStops: readonly PhoneUnconfirmedStop[]; readonly unconfirmedStopsMore: number }> {
    const ledger = await this.#read()
    const stops = ledger.stopIntents.filter(one => one.state !== 'consumed')
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    return { unconfirmedStops: stops.slice(0, limit).map(one => ({ ...publicStop(one), project: basename(one.key.project) })),
      unconfirmedStopsMore: Math.max(0, stops.length - limit) }
  }

  async #stopReceipt(id: string, receipt: MentionStopReceipt): Promise<void> {
    const ledger = await this.#read()
    const stop = ledger.stopIntents.find(one => one.id === id)
    if (!stop || stop.state !== 'inFlight') throw new Error('The stop attempt is no longer current.')
    const receipts = stop.receipts
    let next: StopIntent['receipts']
    if (receipt.kind === 'leadPlan') {
      if (stop.leadPlanTarget !== receipt.target) throw new Error('The Lead stop target changed.')
      next = { ...receipts, leadPlan: true }
    } else {
      const field = receipt.kind === 'queued' ? 'queued' : receipt.kind === 'run' ? 'runs' : receipt.kind === 'interrupt' ? 'interrupts' : 'leadRuns'
      const targets = receipt.kind === 'queued' ? stop.queuedTargets : receipt.kind === 'run' ? stop.runTargets : receipt.kind === 'interrupt' ? stop.interruptTargets : stop.leadRunTargets
      if (!targets.includes(receipt.target)) throw new Error('The stop operation was not in its frozen scope.')
      next = { ...receipts, [field]: receipts[field].includes(receipt.target) ? receipts[field] : [...receipts[field], receipt.target] }
    }
    await this.#write({ ...ledger, stopIntents: ledger.stopIntents.map(one => one.id === id ? { ...one, receipts: next } : one) })
  }

  async #raiseCapacity(stop: StopIntent): Promise<never> {
    const alert = { project: stop.key.project, trigger: stop.key.trigger }
    const alerts = this.#capacityAlerts
    if (!alerts.all && !alerts.triggers.some(one => one.project === alert.project && one.trigger === alert.trigger)) {
      const candidate = { all: false, triggers: [...alerts.triggers, alert] }
      const next = alerts.triggers.length >= TRIGGER_DECISIONS_KEPT || Buffer.byteLength(JSON.stringify({ version: 1, ...candidate })) > 1024 * 1024
        ? { all: true, triggers: [] } : candidate
      try { await atomicJson(this.#capacityFile, { version: 1, ...next }) } catch (error) {
        this.#ledger = null
        this.#problem = 'Stop history could not be saved safely, so mentions wait until a person looks at it.'
        throw error
      }
      this.#capacityAlerts = next
    }
    this.#port.changed(stop.key.project)
    throw new Error('Stop history cannot safely hold this request. Stop the work directly before taking further action.')
  }

  async #reserveStop(ledger: LedgerFile, stop: StopIntent): Promise<void> {
    if (ledger.stopIntents.length >= TRIGGER_DECISIONS_KEPT) {
      return this.#raiseCapacity(stop)
    }
    const worst: StopIntent = { ...stop, state: 'unconfirmed', receipts: { queued: stop.queuedTargets, runs: stop.runTargets,
      interrupts: stop.interruptTargets, leadRuns: stop.leadRunTargets, leadPlan: stop.leadPlanTarget !== null } }
    const stops = [...ledger.stopIntents, worst]
    // Reserve space for a later ordinary success row as well as every receipt.
    if (!isStopIntent(worst) || Buffer.byteLength(JSON.stringify(worst)) > 1024 * 1024 ||
      Buffer.byteLength(JSON.stringify({ ...ledger, stopIntents: stops })) + 16 * 1024 > GOAL_DOCUMENT_LIMIT) {
      return this.#raiseCapacity(stop)
    }
  }

  async #attemptStop(arm: ArmedTrigger, fact: TriggerFact, thread: StoredThread, comment: string,
    allowed: TriggerRuleCheck, handle: string): Promise<void> {
    const url = fact.url ?? ''
    const key = { project: arm.project, trigger: arm.id, repository: (fact.repository ?? '').toLowerCase(), comment }
    const work = { goals: [...new Set(thread.links.goals)], firings: [...new Set(thread.firings)], comment: url }
    let plan: MentionStopPlan | null = null
    const author = fact.login && boundedText(fact.login, 256) && !leadContainsSecret(fact.login) ? fact.login : null
    let stop!: StopIntent
    await this.#port.closeThread(async () => {
      try { plan = await this.#port.planStop?.(work) ?? null } catch { /* No effect was started; retain the uncertainty. */ }
      stop = { version: 1, id: stopId(key), key, bodyDigest: bodyDigest(fact.body ?? ''), threadId: thread.id,
        thread: { kind: fact.thread ?? 'issue', number: Number(fact.subject) }, author, excerpt: excerptOf(fact.body ?? ''), url,
        createdAt: this.#port.now(), state: 'inFlight', decisionId: null, goals: work.goals, firings: work.firings,
        queuedTargets: plan?.queuedTargets ?? [], runTargets: plan?.runTargets ?? [], interruptTargets: plan?.interruptTargets ?? [], leadRunTargets: plan?.leadRunTargets ?? [],
        leadPlanTarget: plan?.leadPlanTarget ?? null, receipts: { queued: [], runs: [], interrupts: [], leadRuns: [], leadPlan: false } }
      const before = await this.#read()
      await this.#reserveStop(before, stop)
      const fence = (one: StoredThread): StoredThread => one.id !== thread.id ? one : { ...one, state: 'closed',
        closed: { reason: 'closed', at: this.#port.now() }, seen: remember(one.seen, comment) }
      await this.#write({ ...before, stopIntents: [...before.stopIntents, stop], threads: before.threads.map(fence),
        pendingThreads: before.pendingThreads.map(one => ({ ...fence(one), pendingFirings: one.pendingFirings })) })
    })
    this.#port.changed(arm.project)

    let complete = false
    if (plan && this.#port.stopOnce) {
      try { complete = (await this.#port.stopOnce(work, STOPPED, plan, receipt => this.#stopReceipt(stop.id, receipt), stop.id)).complete } catch { /* The saved receipts are the only claims we can make. */ }
    }
    const ledger = await this.#read()
    const current = ledger.stopIntents.find(one => one.id === stop.id)
    if (!current || current.state !== 'inFlight') throw new Error('The stop attempt is no longer current.')
    const counts = stopProgress(current)
    const acted = counts.queuedCancelled > 0 || counts.runsMarkedStopped > 0 || counts.interruptRequestsIssued > 0 ||
      counts.leadRunsMarkedStopped > 0 || counts.leadPlanStopped
    const closed = (one: StoredThread): StoredThread => one.id !== thread.id ? one : { ...one, state: 'closed',
      closed: { reason: acted ? 'stopped' : 'closed', at: this.#port.now() }, seen: remember(one.seen, comment) }
    if (!complete) {
      await this.#write({ ...ledger, stopIntents: ledger.stopIntents.map(one => one.id === stop.id ? { ...one, state: 'unconfirmed' } : one),
        threads: ledger.threads.map(closed), pendingThreads: ledger.pendingThreads.map(one => ({ ...closed(one), pendingFirings: one.pendingFirings })) })
      this.#port.changed(arm.project)
      return
    }
    const parts = stoppedParts({ own: counts.runsMarkedStopped, lead: counts.leadRunsMarkedStopped, plan: counts.leadPlanStopped })
    const asked = `Asked by ${author ?? 'someone allowed'} to stop the work on ${threadWords(thread.origin.kind, thread.origin.number)}.`
    const reason = parts.length ? `${asked} ${listWords(parts)} ${parts.length === 1 && counts.runsMarkedStopped + counts.leadRunsMarkedStopped <= 1 ? 'was' : 'were'} stopped, and the thread is closed.`
      : `${asked} nothing of its work was running, so nothing was stopped; the thread is closed.`
    const decision: StoredDecision = { id: `d-${digest([arm.project, arm.id, comment])}`, trigger: arm.id, project: arm.project,
      repository: fact.repository ?? '', thread: stop.thread, comment: { id: comment, url, at: fact.at, author, excerpt: stop.excerpt },
      commentDigest: stop.bodyDigest, decision: 'stop', reason, by: 'rules', rules: [
        { id: 'addressed', passed: true, detail: `Addresses @${handle}.` }, allowed, { id: 'stop-word', passed: true, detail: 'Asks the work on this thread to stop.' },
      ], mode: 'act', acted, work: thread.id, decidedAt: this.#port.now(), evaluations: 0 }
    await this.#write({ ...ledger, decisions: [...ledger.decisions.filter(one => one.id !== decision.id), decision],
      stopIntents: ledger.stopIntents.map(one => one.id === stop.id ? { ...one, state: 'consumed', decisionId: decision.id } : one),
      threads: ledger.threads.map(closed), pendingThreads: ledger.pendingThreads.map(one => ({ ...closed(one), pendingFirings: one.pendingFirings })) })
    this.#port.changed(arm.project)
  }

  reviewStop(project: string, trigger: string, id: string): Promise<TriggerUnconfirmedStop> {
    return this.#serial.run(async () => {
      const ledger = await this.#read()
      const stop = ledger.stopIntents.find(one => one.id === id && one.key.project === project && one.key.trigger === trigger)
      if (!stop || stop.state === 'consumed' || stop.state === 'inFlight') throw Object.assign(new Error('That stop cannot be reviewed.'), { code: 'HD_TRIGGER_REFUSED' })
      if (stop.state === 'reviewed') return publicStop(stop)
      const reviewed: StopIntent = { ...stop, state: 'reviewed' }
      await this.#write({ ...ledger, stopIntents: ledger.stopIntents.map(one => one.id === id ? reviewed : one) })
      this.#port.changed(project)
      return publicStop(reviewed)
    })
  }

  /** Every decision on this desk, newest first, as the phone shows it: a project by its folder name, never a path. */
  async phone(limit: number): Promise<readonly PhoneTriageRow[]> {
    const ledger = await this.#read()
    return [...ledger.decisions].sort((a, b) => b.decidedAt - a.decidedAt).slice(0, limit).map((one) => ({
      id: one.id, trigger: one.trigger, project: basename(one.project), repository: one.repository, thread: one.thread,
      author: one.comment.author, excerpt: leadContainsSecret(one.comment.excerpt) ? '' : one.comment.excerpt, decision: one.decision, reason: one.reason, by: one.by,
      mode: one.mode, acted: one.acted, decidedAt: one.decidedAt, url: one.comment.url,
    }))
  }

  /** The thread kind a Goal's work started on, for its label; null when no thread linked it. */
  originOf(goal: string): TriggerWorkThread['origin'] | null {
    return this.#ledger?.threads.find((one) => one.links.goals.includes(goal))?.origin ?? null
  }

  /** Check without taking the mention queue: admission is to its right. */
  async closedFiring(key: string): Promise<'open' | 'unverified' | 'unknown' | 'unrecorded' | 'recorded' | 'protected'> {
    const ledger = await this.#read()
    if (ledger.stopIntents.some(one => one.state !== 'consumed' && one.firings.includes(key))) return 'protected'
    if (ledger.decisions.some(one => one.closedFiring === key)) return 'recorded'
    const thread = [...ledger.pendingThreads, ...ledger.threads].find(one => one.firings.includes(key))
    if (!thread) return 'unknown'
    if (thread.state === 'closed' || thread.issueClosed) return 'unrecorded'
    const observed = this.#verified.get(key)
    const age = observed === undefined ? -1 : this.#port.now() - observed
    if (age < 0 || age >= this.#port.observationWindowMs) return 'unverified'
    return 'open'
  }

  /** Associate a legacy visible thread after admission releases its queue. */
  associateFiring(key: string): Promise<void> {
    return this.#serial.run(async () => {
      const ledger = await this.#read()
      if (ledger.pendingThreads.some(one => one.firings.includes(key))) return
      if (ledger.threads.some(one => one.firings.includes(key))) await this.#write(ledger)
    })
  }

  /** Remove only anchors whose admission operations have completed. */
  prunePending(): Promise<void> {
    return this.#serial.run(async () => {
      const ledger = await this.#read(), pending = new Set(this.#port.pendingFirings())
      if (ledger.pendingThreads.some(one => one.pendingFirings.some(key => !pending.has(key)))) await this.#write(ledger)
      for (const key of this.#verified.keys()) if (!pending.has(key)) this.#verified.delete(key)
    })
  }

  /** Durable, idempotent decision before admission removes a closed thread's firing. */
  recordClosedFiring(key: string, fact: TriggerFact): Promise<void> {
    return this.#serial.run(async () => {
      const ledger = await this.#read()
      const thread = [...ledger.pendingThreads, ...ledger.threads].find(one => (one.state === 'closed' || one.issueClosed) && one.firings.includes(key))
      if (!thread) return
      const id = `d-${digest([thread.id, 'closed-firing', key])}`
      if (ledger.decisions.some(one => one.id === id)) return
      const decision: StoredDecision = {
        id, trigger: thread.trigger, project: thread.project, repository: thread.repository, thread: thread.origin,
        comment: { id: commentId(fact.url ?? ''), url: fact.url ?? '', at: fact.at, author: fact.login ?? null, excerpt: excerptOf(fact.body ?? '') },
        decision: 'ignore', reason: 'The firing was refused because its mention thread is closed.', by: 'rules', rules: [],
        mode: 'act', acted: false, work: thread.id, decidedAt: this.#port.now(), evaluations: 0, closedFiring: key,
      }
      await this.#write({ ...ledger, decisions: [...ledger.decisions, decision] })
      this.#port.changed(thread.project)
    })
  }

  // --------------------------------------------------------------- judge

  /**
   * One comment, offered to one mention arm. Resolves once it is decided
   * and recorded, joined, counted, or found to be nothing for this trigger;
   * throws — so the source keeps it and offers it again — when anything it
   * needs could not be read or admitted now.
   */
  judge(arm: ArmedTrigger, fact: TriggerFact, admit: Admit): Promise<void> {
    return this.#serial.run(async () => {
      if (fact.desk === true || fact.source !== 'mention' || fact.project !== arm.project) return
      const id = commentId(fact.url ?? '')
      if (!id) return
      let ledger = await this.#read()
      const identity = { project: arm.project, trigger: arm.id, repository: (fact.repository ?? '').toLowerCase(), comment: id }
      if (ledger.stopIntents.some(one => stopKey(one.key) === stopKey(identity))) return
      if (ledger.decisions.some((one) => one.project === arm.project && one.trigger === arm.id && one.comment.id === id)) return
      const handle = this.#handle(arm.definition)
      const number = Number(fact.subject)
      const mode = this.#modeOf(ledger, arm)
      const addressed = addressesHandle(fact.body ?? '', handle)

      const retryingUnconfirmed = addressed && asksToStop(fact.body ?? '', handle)
      const linked = [...ledger.threads, ...ledger.pendingThreads].find((one) => one.project === arm.project && one.trigger === arm.id &&
        (one.state === 'open' || retryingUnconfirmed && ledger.stopIntents.some(stop => stop.threadId === one.id && stop.state !== 'consumed')) &&
        (one.links.issues.includes(number) || one.links.pulls.includes(number)))
      if (linked) {
        if (linked.seen.includes(id)) return
        const allowed = await this.#allowed(arm, fact)
        if (!allowed.passed) {
          await this.#thread(linked.id, (one) => ({ ...one, observations: one.observations + 1, seen: remember(one.seen, id) }))
          return
        }
        if (addressed && asksToStop(fact.body ?? '', handle)) {
          if (mode === 'act') {
            await this.#attemptStop(arm, fact, linked, id, allowed, handle)
            return
          }
          const asked = `Asked by ${fact.login ?? 'someone allowed'} to stop the work on ${threadWords(linked.origin.kind, linked.origin.number)}.`
          const verdict: Verdict = {
            decision: 'stop', by: 'rules',
            reason: asked,
            rules: [{ id: 'addressed', passed: true, detail: `Addresses @${handle}.` }, allowed, { id: 'stop-word', passed: true, detail: 'Asks the work on this thread to stop.' }],
          }
          await this.#thread(linked.id, (one) => ({ ...one, seen: remember(one.seen, id) }))
          await this.#record(arm, fact, verdict, mode, false, null)
          return
        }
        // Discussion on the thread asks the desk for nothing: only a comment that addresses the handle resumes the work.
        if (!addressed) {
          await this.#thread(linked.id, (one) => ({ ...one, observations: one.observations + 1, seen: remember(one.seen, id) }))
          return
        }
        if (linked.issueClosed) {
          await this.#thread(linked.id, one => ({ ...one, seen: remember(one.seen, id) }))
          await this.#record(arm, fact, { decision: 'ignore', by: 'rules', reason: `${threadWords(linked.origin.kind, linked.origin.number)} is already closed.`,
            rules: [{ id: 'addressed', passed: true, detail: `Addresses @${handle}.` }, allowed, { id: 'handled', passed: false, detail: 'The issue is already closed.' }] }, mode, false, null)
          return
        }
        if (mode !== 'act') return
        const answer = await admit(arm, { ...fact, subject: String(linked.origin.number), thread: linked.origin.kind })
        await this.#thread(linked.id, (one) => ({
          ...one, resumes: one.resumes + 1, seen: remember(one.seen, id),
          firings: one.firings.includes(answer.firing) ? one.firings : [...one.firings, answer.firing],
          links: {
            ...one.links,
            goals: answer.goal && !one.links.goals.includes(answer.goal) ? [...one.links.goals, answer.goal] : one.links.goals,
          },
        }))
        ledger = await this.#read()
        const resumed = [...ledger.threads, ...ledger.pendingThreads].find((one) => one.id === linked.id)
        if (resumed) await this.#attach(resumed)
        this.#port.changed(arm.project)
        return
      }

      // Ordinary discussion on a thread no work follows: not a request, so no decision.
      if (!addressed) return
      const verdict = await this.#gate(arm, fact, handle)
      ledger = await this.#read()
      let acted = false
      let work: string | null = null
      let reason = verdict.reason
      if (verdict.decision === 'accept' && mode === 'act') {
        const answer = await admit(arm, fact)
        if (answer.outcome === 'skipped') reason = `${reason} It did not start: ${answer.reason ?? 'the trigger skipped it.'}`
        else {
          acted = true
          work = await this.#open(arm, fact, answer, id)
        }
      }
      const decision = await this.#record(arm, fact, { ...verdict, reason }, mode, acted, work)
      // Observing raises nothing: the person reads what it would have done on the trigger's page.
      if (decision.decision === 'ask' && mode === 'act') await this.#port.ask(arm, decision)
    })
  }

  /**
   * A person asks for a decision to be made again: the comment is read again
   * as the forge holds it now, and the rules and the assessment run again
   * under the trigger's mode now. An accept that acts now opens its work,
   * once.
   */
  reevaluate(arm: ArmedTrigger, decisionId: string, admit: Admit): Promise<TriggerDecision> {
    return this.#serial.run(async () => {
      const snapshot = await this.#read()
      if (snapshot.stopIntents.some(one => one.key.project === arm.project && one.key.trigger === arm.id &&
        (one.decisionId === decisionId || `d-${digest([one.key.project, one.key.trigger, one.key.comment])}` === decisionId))) {
        throw Object.assign(new Error('A consumed stop cannot be evaluated again. Issue a new stop request if needed.'), { code: 'HD_TRIGGER_REFUSED' })
      }
      const before = snapshot.decisions.find((one) => one.id === decisionId && one.project === arm.project && one.trigger === arm.id)
      if (!before) throw Object.assign(new Error('There is no such decision on this trigger.'), { code: 'HD_TRIGGER_REFUSED' })
      if (before.closedFiring) throw Object.assign(new Error('This records a refused firing; it is not a comment to re-evaluate.'), { code: 'HD_TRIGGER_REFUSED' })
      const fact = { ...await this.#port.forge.comment(arm.project, before.repository, Number(before.comment.id), this.#port.signal), project: arm.project }
      if (before.commentDigest !== undefined && bodyDigest(fact.body ?? '') !== before.commentDigest) throw Object.assign(new Error(EDITED), { code: 'HD_TRIGGER_REFUSED' })
      const handle = this.#handle(arm.definition)
      const verdict: Verdict = addressesHandle(fact.body ?? '', handle)
        ? await this.#gate(arm, fact, handle, true)
        : { decision: 'ignore', by: 'rules', reason: `This comment no longer addresses @${handle}.`, rules: [{ id: 'addressed', passed: false, detail: `This comment no longer addresses @${handle}.` }] }
      const ledger = await this.#read()
      const mode = this.#modeOf(ledger, arm)
      let acted = before.acted
      let work = before.work
      let reason = verdict.reason
      if (verdict.decision === 'accept' && mode === 'act' && !before.acted) {
        const answer = await admit(arm, fact)
        if (answer.outcome === 'skipped') reason = `${reason} It did not start: ${answer.reason ?? 'the trigger skipped it.'}`
        else {
          acted = true
          work = await this.#open(arm, fact, answer, before.comment.id)
        }
      }
      const after: StoredDecision = {
        ...before, commentDigest: bodyDigest(fact.body ?? ''), decision: verdict.decision, reason, by: verdict.by, rules: verdict.rules, mode, acted, work,
        comment: { ...before.comment, excerpt: excerptOf(fact.body ?? '') },
        decidedAt: this.#port.now(), evaluations: before.evaluations + 1,
      }
      const now = await this.#read()
      await this.#write({ ...now, decisions: now.decisions.map((one) => one.id === after.id ? after : one) })
      this.#port.changed(arm.project)
      if (after.decision === 'ask' && mode === 'act') await this.#port.ask(arm, after)
      return publicDecision(after)
    })
  }

  /**
   * Follows every open thread: links the pull requests its work opened, and
   * closes it once every linked pull request merged or closed. A read that
   * fails leaves the thread as it was, for the next pass.
   */
  sweep(): Promise<void> {
    return this.#serial.run(async () => {
      if (this.#problem) return
      let ledger: LedgerFile
      try {
        ledger = await this.#read()
      } catch {
        return
      }
      const unique = new Map([...ledger.pendingThreads, ...ledger.threads].map(one => [one.id, one]))
      const open = [...unique.values()].filter(one => one.state === 'open')
      // Never check more threads per sweep than the existing history bound;
      // rotate so evicted but pending work is not starved.
      const batch = open.length <= TRIGGER_THREADS_KEPT ? open : Array.from({ length: TRIGGER_THREADS_KEPT }, (_, i) => open[(this.#sweepOffset + i) % open.length]!)
      this.#sweepOffset = open.length ? (this.#sweepOffset + batch.length) % open.length : 0
      for (const thread of batch) {
        try {
          const pending = new Set(this.#port.pendingFirings())
          if (thread.firings.some(key => pending.has(key)) && !this.#port.knowsFirings(thread.project, thread.trigger, thread.firings))
            throw new Error('a pending thread firing has no durable intake record')
          const found = await this.#port.pullRequests(thread.repository, thread.links.goals, thread.firings)
          const pulls = [...new Set([...thread.links.pulls, ...found.filter((one) => Number.isSafeInteger(one) && one > 0)])]
          let next: StoredThread = pulls.length === thread.links.pulls.length ? thread : { ...thread, links: { ...thread.links, pulls } }
          if (pulls.length > 0) {
            if (next.issueClosed) next = { ...next, issueClosed: false }
            const states = await Promise.all(pulls.map((one) => this.#port.forge.pullState(thread.project, thread.repository, one, this.#port.signal)))
            if (states.every((state) => state !== 'open')) {
              next = { ...next, state: 'closed', closed: { reason: states.includes('merged') ? 'merged' : 'closed', at: this.#port.now() } }
            }
          } else if (thread.links.issues.length > 0) {
            // No pull request yet: the thread ends when every issue it follows is closed.
            const issues = await Promise.all(thread.links.issues.map((one) => this.#port.forge.thread(thread.project, thread.repository, one, this.#port.signal)))
            const issueClosed = issues.every((issue) => issue.state === 'closed')
            if (issueClosed && (this.#port.activeWork?.(thread.links.goals, thread.firings) ?? true)) {
              if (!next.issueClosed) next = { ...next, issueClosed: true }
            } else if (issueClosed) {
              next = { ...next, issueClosed: true, state: 'closed', closed: { reason: 'closed', at: this.#port.now() } }
            } else if (next.issueClosed) next = { ...next, issueClosed: false }
          }
          if (next.state === 'open' && !next.issueClosed && (pulls.length > 0 || next.links.issues.length > 0)) {
            for (const key of next.firings) if (pending.has(key)) this.#verified.set(key, this.#port.now())
          } else if (next.state === 'closed' || next.issueClosed) {
            for (const key of next.firings) this.#verified.delete(key)
          }
          if (next !== thread) {
            if (next.state === 'closed' || next.issueClosed !== thread.issueClosed) await this.#port.closeThread(() => this.#thread(thread.id, () => next).then(() => {}))
            else await this.#thread(thread.id, () => next)
            if (next.links !== thread.links) await this.#attach(next)
            this.#port.changed(thread.project)
          } else if (thread.workItem === undefined) {
            // Opened while the desk kept no work ledger, or one that could not take it: it joins one when it can.
            await this.#attach(thread, true)
          }
        } catch (error) {
          for (const key of thread.firings) this.#verified.delete(key)
          this.#port.log('a mention thread could not be followed', { error: error instanceof Error ? error.message : String(error) })
        }
      }
    })
  }

  // ------------------------------------------------------------- the gate

  #handle(definition: TriggerDefinition): string {
    return (definition.handle ?? this.#port.leadName()).toLowerCase()
  }

  /** Whether the comment's author may ask this trigger for work: the arming account, a named person or bot by id, or a collaborator. */
  async #allowed(arm: ArmedTrigger, fact: TriggerFact, refreshNegative = false): Promise<TriggerRuleCheck> {
    const definition = arm.definition
    const fail = (who: string): TriggerRuleCheck => ({ id: 'allowed', passed: false, detail: `${who} is not on this trigger’s list: ${allowedWords(definition)}.` })
    if (typeof fact.author !== 'string') return { id: 'allowed', passed: false, detail: 'Who wrote this comment could not be read.' }
    if (fact.author === arm.binding.account) return { id: 'allowed', passed: true, detail: 'The arming account.' }
    const login = fact.login ?? null
    if (!login) return fail('Its author')
    const signal = this.#port.signal
    if (fact.bot === true) {
      if ((definition.bots ?? []).includes(login) && await this.#cached(['account', arm.project, login, 'bot', fact.author], () => this.#port.forge.isAccount(arm.project, login, true, fact.author!, signal), refreshNegative)) {
        return { id: 'allowed', passed: true, detail: `The bot ${login}, named on this trigger.` }
      }
      return fail(`The bot ${login}`)
    }
    if ((definition.people ?? []).includes(login) && await this.#cached(['account', arm.project, login, 'person', fact.author], () => this.#port.forge.isAccount(arm.project, login, false, fact.author!, signal), refreshNegative)) {
      return { id: 'allowed', passed: true, detail: `${login}, named on this trigger.` }
    }
    const repository = fact.repository
    if (definition.from === 'collaborators' && repository && await this.#cached(['writes', arm.project, repository, login, fact.author], () => this.#port.forge.writes(arm.project, repository, login, fact.author!, signal), refreshNegative)) {
      return { id: 'allowed', passed: true, detail: `${login} can write to the repository.` }
    }
    return fail(login)
  }

  /** A who-may-ask answer read within the last few minutes, or read now; a read that fails is never kept. */
  async #cached(question: readonly string[], read: () => Promise<boolean>, refreshNegative = false): Promise<boolean> {
    const key = JSON.stringify(question)
    const now = this.#port.now()
    const kept = this.#accounts.get(key)
    if (kept && (kept.answer || !refreshNegative) && now - kept.at >= 0 && now - kept.at < ACCOUNT_TTL_MS) return kept.answer
    const answer = await read()
    if (this.#accounts.size >= 512) this.#accounts.clear()
    this.#accounts.set(key, { answer, at: now })
    return answer
  }

  /** The rules in order, stopping at the first that fails; then, when every rule passed, one assessment. */
  async #gate(arm: ArmedTrigger, fact: TriggerFact, handle: string, refreshNegative = false): Promise<Verdict> {
    const definition = arm.definition
    const number = Number(fact.subject)
    const kind = fact.thread ?? 'issue'
    const rules: TriggerRuleCheck[] = [{ id: 'addressed', passed: true, detail: `Addresses @${handle}.` }]
    const ignore = (rule: TriggerRuleCheck): Verdict => {
      rules.push(rule)
      return { decision: 'ignore', by: 'rules', reason: rule.detail ?? 'A rule did not pass.', rules }
    }
    const allowed = await this.#allowed(arm, fact, refreshNegative)
    if (!allowed.passed) return ignore(allowed)
    rules.push(allowed)
    if (fact.project !== arm.project || fact.repository !== arm.binding.repository) {
      return ignore({ id: 'project', passed: false, detail: 'This comment is on another repository than the one this trigger was armed for.' })
    }
    rules.push({ id: 'project', passed: true, detail: null })
    const thread = await this.#port.forge.thread(arm.project, fact.repository!, number, this.#port.signal)
    const labels = definition.label ?? []
    if (labels.length > 0) {
      const has = new Set(thread.labels.map((one) => one.toLowerCase()))
      if (!labels.some((one) => has.has(one.toLowerCase()))) {
        return ignore({ id: 'label', passed: false, detail: `${threadWords(kind, number)} carries none of this trigger’s labels: ${labels.join(', ')}.` })
      }
      rules.push({ id: 'label', passed: true, detail: null })
    }
    if (thread.state === 'closed') return ignore({ id: 'handled', passed: false, detail: `${threadWords(kind, number)} is already closed.` })
    rules.push({ id: 'handled', passed: true, detail: null })
    if (asksToStop(fact.body ?? '', handle)) return ignore({ id: 'stop-word', passed: false, detail: 'It asks to stop, and no work follows this thread.' })

    const ask = (reason: string, by: Verdict['by']): Verdict => ({ decision: 'ask', reason, by, rules })
    if (leadContainsSecret(fact.body ?? '')) return ask(ASSESS_SECRET, 'rules')
    if (!this.#port.assess) return ask(ASSESS_UNAVAILABLE, 'assessment')
    const ledger = await this.#read()
    const day = new Date(this.#port.now()).toISOString().slice(0, 10)
    const count = ledger.assessed.day === day ? ledger.assessed.count : 0
    if (count >= ASSESSMENTS_PER_DAY) return ask(ASSESS_CAPPED, 'rules')
    await this.#write({ ...ledger, assessed: { day, count: count + 1 } })
    let answer: MentionAssessment | null = null
    try {
      answer = await this.#port.assess({
        trigger: { id: definition.id, handle, opens: opensWords(definition) },
        repository: fact.repository!,
        thread: { kind, number, title: thread.title },
        comment: { author: fact.login ?? null, body: fact.body ?? '' },
      }, this.#port.signal)
    } catch {
      answer = null
    }
    if (!answer) return ask(ASSESS_UNAVAILABLE, 'assessment')
    return { decision: answer.decision, reason: answer.reason, by: 'assessment', rules }
  }

  // ------------------------------------------------------------- records

  async #record(arm: ArmedTrigger, fact: TriggerFact, verdict: Verdict, mode: TriggerMode, acted: boolean, work: string | null): Promise<TriggerDecision> {
    const id = commentId(fact.url ?? '')
    const decision: StoredDecision = {
      commentDigest: bodyDigest(fact.body ?? ''),
      id: `d-${digest([arm.project, arm.id, id])}`, trigger: arm.id, project: arm.project, repository: fact.repository ?? '',
      thread: { kind: fact.thread ?? 'issue', number: Number(fact.subject) },
      comment: { id, url: fact.url ?? '', at: fact.at, author: fact.login ?? null, excerpt: excerptOf(fact.body ?? '') },
      decision: verdict.decision, reason: verdict.reason, by: verdict.by, rules: verdict.rules,
      mode, acted, work, decidedAt: this.#port.now(), evaluations: 0,
    }
    const ledger = await this.#read()
    await this.#write({ ...ledger, decisions: [...ledger.decisions.filter((one) => one.id !== decision.id), decision] })
    this.#port.changed(arm.project)
    return publicDecision(decision)
  }

  /** A new thread of work for an accepted request that was admitted; its id. */
  async #open(arm: ArmedTrigger, fact: TriggerFact, answer: OfferAnswer, comment: string): Promise<string> {
    const number = Number(fact.subject)
    const kind = fact.thread ?? 'issue'
    const thread: StoredThread = {
      id: `w-${digest([arm.project, arm.id, comment])}`, trigger: arm.id, project: arm.project, repository: fact.repository ?? '',
      origin: { kind, number },
      links: { issues: kind === 'issue' ? [number] : [], pulls: kind === 'pull-request' ? [number] : [], goals: answer.goal ? [answer.goal] : [] },
      state: 'open', closed: null, resumes: 0, observations: 0, openedAt: this.#port.now(),
      firings: [answer.firing], seen: [comment], ...(fact.url ? { comment: fact.url } : {}),
    }
    const ledger = await this.#read()
    await this.#write({ ...ledger, threads: [...ledger.threads.filter((one) => one.id !== thread.id), thread] })
    // #gate just observed this new thread open, before admission parked it.
    if (this.#port.pendingFirings().includes(answer.firing) && this.#port.knowsFirings(thread.project, thread.trigger, thread.firings)) this.#verified.set(answer.firing, this.#port.now())
    await this.#attach(thread)
    return thread.id
  }

  /**
   * Puts the thread on the work ledger. One the ledger refused is said once, and a sweep (`retry`) offers it again
   * only after `ATTACH_RETRY_MS`, not on every pass; a change to the thread's links offers it at once.
   */
  async #attach(thread: StoredThread, retry = false): Promise<void> {
    const held = this.#attachHeld.get(thread.id)
    if (retry && held !== undefined && this.#port.now() < held) return
    try {
      const item = await this.#port.workItems.attach({ kind: 'mention', trigger: thread.trigger, repository: thread.repository, thread: thread.origin, comment: thread.comment ?? null }, thread.links)
      this.#attachHeld.delete(thread.id)
      this.#attachSaid.delete(thread.id)
      if (item !== null && item !== thread.workItem) await this.#thread(thread.id, (one) => ({ ...one, workItem: item }))
    } catch (error) {
      this.#attachHeld.set(thread.id, this.#port.now() + ATTACH_RETRY_MS)
      if (this.#attachSaid.has(thread.id)) return
      this.#attachSaid.add(thread.id)
      this.#port.log('a mention thread could not be attached to the work ledger', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  async #thread(id: string, change: (thread: StoredThread) => StoredThread): Promise<void> {
    const ledger = await this.#read()
    await this.#write({ ...ledger, threads: ledger.threads.map((one) => one.id === id ? change(one) : one),
      pendingThreads: ledger.pendingThreads.map(one => one.id === id ? { ...change(one), pendingFirings: one.pendingFirings } : one) })
  }
}

const remember = (seen: readonly string[], id: string): readonly string[] => [...seen, id].slice(-THREAD_SEEN)

const runWords = (count: number): string => count === 1 ? '1 run' : `${count} runs`

/** What a stop stopped, by whose it was: "1 run of its work", "2 runs the Lead started for it", "the Lead’s plan for it". */
const stoppedParts = (counts: { readonly own: number; readonly lead: number; readonly plan: boolean }): readonly string[] => [
  ...(counts.own > 0 ? [`${runWords(counts.own)} of its work`] : []),
  ...(counts.lead > 0 ? [`${runWords(counts.lead)} the Lead started for it`] : []),
  ...(counts.plan ? ['the Lead’s plan for it'] : []),
]

const publicDecision = (decision: StoredDecision): TriggerDecision => {
  const { commentDigest: _digest, closedFiring: _closedFiring, ...rest } = decision
  return rest
}

const publicThread = (thread: StoredThread): TriggerWorkThread => {
  const { firings: _firings, seen: _seen, comment: _comment, workItem: _workItem, issueClosed: _issueClosed, ...rest } = thread
  return rest
}
