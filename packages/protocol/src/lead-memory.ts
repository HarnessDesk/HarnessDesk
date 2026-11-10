/**
 * The Lead's memory: entries in two tiers, an inbox of the Lead's proposals the person decides on, and versions that
 * every change leaves behind. Core is always in the Lead's standing instructions, frozen for an epoch of its
 * conversation; Archive is searched on demand. The host owns every field. Entry text is untrusted prose wherever it is
 * shown or sent to a model: a person's entries are their words, the Lead's are the model's.
 */
import { arrayOf, isBoolean, isNumber, isObject, isString, literalUnion, optional, ValidationError, type Validator } from './validate.js'

export const LEAD_MEMORY_LIMITS = Object.freeze({
  /** One entry, in UTF-16 units. */
  textChars: 400,
  /** Core as the Lead reads it, envelope and all, in UTF-8 bytes. */
  coreBytes: 6144,
  /** Entries kept, Core and Archive together. */
  entries: 400,
  /** Proposals waiting for the person. A full inbox refuses the next proposal until one is decided. */
  inbox: 24,
  /** Versions kept for Undo. */
  versions: 40,
  /** Proposals the person said No to, remembered so the same one is not offered again. */
  declined: 200,
  /** A search: query length, results and the bytes the results may carry. */
  queryChars: 300,
  results: 5,
  resultBytes: 2048,
  /** A Core entry of the Lead's that nobody used for this long goes to Archive at the next tidy. */
  unusedMs: 60 * 24 * 60 * 60 * 1000,
  /** At most one tidy in this long. */
  tidyEveryMs: 24 * 60 * 60 * 1000,
  /** A tidy after which no entry says more than this share of the distinct words the Lead's entries said is refused whole. */
  tidyLossShare: 0.30,
  /** What the tidy may spend in a day, in micro-dollars, on the observer model. */
  tidyDailyUsdMicros: 20_000,
  idChars: 64,
} as const)

export type LeadMemoryKind = 'preference' | 'fact' | 'lesson' | 'rule'
export const LEAD_MEMORY_KINDS = ['preference', 'fact', 'lesson', 'rule'] as const satisfies readonly LeadMemoryKind[]
export type LeadMemoryAuthor = 'person' | 'lead'
export type LeadMemoryTier = 'core' | 'archive'
/** Where an entry came from: a reply of the Lead's, a reviewed result, a tidy, or the person's own Settings. */
export type LeadMemorySourceKind = 'message' | 'result' | 'consolidation' | 'settings'
export interface LeadMemorySource { readonly kind: LeadMemorySourceKind; readonly id: string }

export interface LeadMemoryEntry {
  readonly id: string
  readonly text: string
  readonly kind: LeadMemoryKind
  /** Who wrote it. The person's entries are never edited by the Lead or by a tidy. */
  readonly by: LeadMemoryAuthor
  readonly tier: LeadMemoryTier
  readonly source: LeadMemorySource
  readonly createdAt: number
  /** When a search last returned it or a proposal repeated it; null when never. */
  readonly usedAt: number | null
  /** Bumped by each edit. */
  readonly version: number
}
/** A proposal of the Lead's waiting for the person: Keep, Edit or No. */
export interface LeadMemoryCandidate {
  readonly id: string
  readonly text: string
  readonly kind: LeadMemoryKind
  readonly source: LeadMemorySource
  readonly proposedAt: number
  /** The Lead's journal position when it proposed this: the first reply after it carries the Keep chip. */
  readonly afterSeq: number
}
/** Why the desk refused a proposal before it reached the inbox. */
export type LeadMemoryRefusal = 'empty' | 'too-long' | 'instruction' | 'secret' | 'quoted-output' | 'duplicate' | 'declined' | 'inbox-full'
export const LEAD_MEMORY_REFUSALS = ['empty', 'too-long', 'instruction', 'secret', 'quoted-output', 'duplicate', 'declined', 'inbox-full'] as const satisfies readonly LeadMemoryRefusal[]

export type LeadMemoryChangeBy = 'person' | 'lead' | 'tidy' | 'undo' | 'migration'
/** One version in the history: what changed, in counts, and whether Undo can still put it back exactly. */
export interface LeadMemoryVersionSummary {
  readonly version: number
  readonly at: number
  readonly by: LeadMemoryChangeBy
  readonly added: number
  readonly removed: number
  readonly changed: number
  /** A tidy's own counts. */
  readonly tidy?: { readonly merged: number; readonly replaced: number; readonly archived: number }
  /** False once a later change touched what this one changed, or once Forget erased what it held. */
  readonly undoable: boolean
  readonly undone?: true
}
export interface LeadMemoryView {
  readonly version: 1
  /** Bumped by every change, inbox included. */
  readonly revision: number
  /** Core in the order the Lead reads it: the person's entries first, then the Lead's most recently used. */
  readonly core: readonly LeadMemoryEntry[]
  readonly archive: readonly LeadMemoryEntry[]
  readonly inbox: readonly LeadMemoryCandidate[]
  /** Newest first. */
  readonly history: readonly LeadMemoryVersionSummary[]
  /** Core as the Lead reads it, in UTF-8 bytes, against `LEAD_MEMORY_LIMITS.coreBytes`. */
  readonly coreBytes: number
  /** "Keep the Lead's notes without asking": facts and lessons skip the inbox. Off by default. */
  readonly auto: boolean
  readonly lastTidyAt: number | null
  /** Set while the journal refuses this Core: the Lead goes on reading the copy it last accepted, and the window says so. */
  readonly fault?: 'journal'
}

/** What the person does: in Settings, or on a Keep chip under a reply (keep, edit, dismiss). */
export type LeadMemoryChange =
  | { readonly action: 'add'; readonly text: string; readonly kind: LeadMemoryKind; readonly tier?: LeadMemoryTier }
  | { readonly action: 'edit'; readonly id: string; readonly text: string; readonly kind?: LeadMemoryKind }
  | { readonly action: 'keep'; readonly id: string; readonly text?: string; readonly kind?: LeadMemoryKind }
  | { readonly action: 'dismiss'; readonly id: string }
  | { readonly action: 'move'; readonly id: string; readonly tier: LeadMemoryTier }
  | { readonly action: 'forget'; readonly id: string }
  | { readonly action: 'forget-all' }
  | { readonly action: 'auto'; readonly on: boolean }
  | { readonly action: 'undo'; readonly version: number }

/** The Lead's proposal, through `memory_propose`. */
export interface LeadMemoryProposal {
  readonly text: string
  readonly kind: LeadMemoryKind
  /** The work or result it came from, when there is one. */
  readonly source?: { readonly kind: 'message' | 'result'; readonly id: string }
}
export interface LeadMemoryProposalResult {
  readonly outcome: 'inbox' | 'kept' | 'refused'
  readonly id?: string
  readonly reason?: LeadMemoryRefusal
}
export interface LeadMemorySearch { readonly query: string; readonly limit?: number }
/** One hit: Archive entries, the Lead's own past conversation (the person's and its own words), and the summaries
 * that replaced earlier parts of it. */
export interface LeadMemoryHit {
  readonly text: string
  /** Epoch milliseconds, and the same as a calendar day for reading. */
  readonly at: number
  readonly date: string
  readonly source: { readonly kind: 'memory' | 'conversation' | 'summary'; readonly id: string; readonly by?: LeadMemoryAuthor | 'assistant' }
}
export interface LeadMemorySearchResult { readonly results: readonly LeadMemoryHit[] }

const fail = (path: string, message: string): never => { throw new ValidationError(path, message) }
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const at = (path: string, key: string) => path ? `${path}.${key}` : key
const text = (max: number): Validator<string> => (value, path = '') => {
  const out = isString(value, path)
  if (!out.trim() || out.length > max || controls.test(out)) fail(path, `expected text up to ${max} characters`)
  return out
}
const id: Validator<string> = (value, path = '') => {
  const out = isString(value, path)
  return /^[A-Za-z0-9._:-]{1,64}$/.test(out) ? out : fail(path, 'expected a memory id')
}
const time: Validator<number> = (value, path = '') => {
  const out = isNumber(value, path)
  return Number.isSafeInteger(out) && out >= 0 ? out : fail(path, 'expected epoch milliseconds')
}
const count: Validator<number> = time
const only = (allowed: readonly string[]): Validator<Record<string, unknown>> => (value, path = '') => {
  const source = isObject(value, path)
  for (const key of Object.keys(source)) if (!allowed.includes(key)) fail(path, `unexpected field ${key}`)
  return source
}
const kind = literalUnion(...LEAD_MEMORY_KINDS)
const tier = literalUnion('core', 'archive')
const source: Validator<LeadMemorySource> = (value, path = '') => {
  const item = only(['kind', 'id'])(value, path)
  return { kind: literalUnion('message', 'result', 'consolidation', 'settings')(item.kind, at(path, 'kind')), id: text(256)(item.id, at(path, 'id')) }
}
export const parseLeadMemoryEntry: Validator<LeadMemoryEntry> = (value, path = '') => {
  const item = only(['id', 'text', 'kind', 'by', 'tier', 'source', 'createdAt', 'usedAt', 'version'])(value, path)
  return { id: id(item.id, at(path, 'id')), text: text(LEAD_MEMORY_LIMITS.textChars)(item.text, at(path, 'text')), kind: kind(item.kind, at(path, 'kind')),
    by: literalUnion('person', 'lead')(item.by, at(path, 'by')), tier: tier(item.tier, at(path, 'tier')), source: source(item.source, at(path, 'source')),
    createdAt: time(item.createdAt, at(path, 'createdAt')), usedAt: item.usedAt === null ? null : time(item.usedAt, at(path, 'usedAt')),
    version: count(item.version, at(path, 'version')) }
}
export const parseLeadMemoryCandidate: Validator<LeadMemoryCandidate> = (value, path = '') => {
  const item = only(['id', 'text', 'kind', 'source', 'proposedAt', 'afterSeq'])(value, path)
  return { id: id(item.id, at(path, 'id')), text: text(LEAD_MEMORY_LIMITS.textChars)(item.text, at(path, 'text')), kind: kind(item.kind, at(path, 'kind')),
    source: source(item.source, at(path, 'source')), proposedAt: time(item.proposedAt, at(path, 'proposedAt')), afterSeq: count(item.afterSeq, at(path, 'afterSeq')) }
}
const versionSummary: Validator<LeadMemoryVersionSummary> = (value, path = '') => {
  const item = only(['version', 'at', 'by', 'added', 'removed', 'changed', 'tidy', 'undoable', 'undone'])(value, path)
  const tidy = item.tidy === undefined ? undefined : only(['merged', 'replaced', 'archived'])(item.tidy, at(path, 'tidy'))
  return { version: count(item.version, at(path, 'version')), at: time(item.at, at(path, 'at')),
    by: literalUnion('person', 'lead', 'tidy', 'undo', 'migration')(item.by, at(path, 'by')),
    added: count(item.added, at(path, 'added')), removed: count(item.removed, at(path, 'removed')), changed: count(item.changed, at(path, 'changed')),
    ...(tidy ? { tidy: { merged: count(tidy.merged, at(path, 'tidy.merged')), replaced: count(tidy.replaced, at(path, 'tidy.replaced')), archived: count(tidy.archived, at(path, 'tidy.archived')) } } : {}),
    undoable: isBoolean(item.undoable, at(path, 'undoable')), ...(item.undone === true ? { undone: true as const } : {}) }
}
const bounded = <T>(item: Validator<T>, max: number, label: string): Validator<T[]> => (value, path = '') => {
  const out = arrayOf(item)(value, path)
  return out.length <= max ? out : fail(path, `expected at most ${max} ${label}`)
}
export const parseLeadMemoryView: Validator<LeadMemoryView> = (value, path = '') => {
  const item = only(['version', 'revision', 'core', 'archive', 'inbox', 'history', 'coreBytes', 'auto', 'lastTidyAt', 'fault'])(value, path)
  if (item.fault !== undefined && item.fault !== 'journal') fail(at(path, 'fault'), 'unknown memory fault')
  if (item.version !== 1) fail(at(path, 'version'), 'unsupported memory version')
  return { version: 1, revision: count(item.revision, at(path, 'revision')),
    core: bounded(parseLeadMemoryEntry, LEAD_MEMORY_LIMITS.entries, 'entries')(item.core, at(path, 'core')),
    archive: bounded(parseLeadMemoryEntry, LEAD_MEMORY_LIMITS.entries, 'entries')(item.archive, at(path, 'archive')),
    // Lines offered before the inbox existed carry across whole, so a view may briefly hold more than a new proposal may fill.
    inbox: bounded(parseLeadMemoryCandidate, LEAD_MEMORY_LIMITS.entries, 'proposals')(item.inbox, at(path, 'inbox')),
    history: bounded(versionSummary, LEAD_MEMORY_LIMITS.versions, 'versions')(item.history, at(path, 'history')),
    coreBytes: count(item.coreBytes, at(path, 'coreBytes')), auto: isBoolean(item.auto, at(path, 'auto')),
    lastTidyAt: item.lastTidyAt === null ? null : time(item.lastTidyAt, at(path, 'lastTidyAt')), ...(item.fault === 'journal' ? { fault: 'journal' as const } : {}) }
}
export const parseLeadMemoryChange: Validator<LeadMemoryChange> = (value, path = '') => {
  const item = isObject(value, path), action = isString(item.action, at(path, 'action'))
  const entry = (allowed: readonly string[]) => only(['action', ...allowed])(value, path)
  const words = (key: string) => text(LEAD_MEMORY_LIMITS.textChars)(item[key], at(path, key))
  switch (action) {
    case 'add': { entry(['text', 'kind', 'tier']); const place = optional(tier)(item.tier, at(path, 'tier'))
      return { action, text: words('text'), kind: kind(item.kind, at(path, 'kind')), ...(place ? { tier: place } : {}) } }
    case 'edit': { entry(['id', 'text', 'kind']); const sort = optional(kind)(item.kind, at(path, 'kind'))
      return { action, id: id(item.id, at(path, 'id')), text: words('text'), ...(sort ? { kind: sort } : {}) } }
    case 'keep': { entry(['id', 'text', 'kind']); const sort = optional(kind)(item.kind, at(path, 'kind'))
      return { action, id: id(item.id, at(path, 'id')), ...(item.text === undefined ? {} : { text: words('text') }), ...(sort ? { kind: sort } : {}) } }
    case 'dismiss': entry(['id']); return { action, id: id(item.id, at(path, 'id')) }
    case 'forget': entry(['id']); return { action, id: id(item.id, at(path, 'id')) }
    case 'move': entry(['id', 'tier']); return { action, id: id(item.id, at(path, 'id')), tier: tier(item.tier, at(path, 'tier')) }
    case 'forget-all': entry([]); return { action }
    case 'auto': entry(['on']); return { action, on: isBoolean(item.on, at(path, 'on')) }
    case 'undo': entry(['version']); return { action, version: count(item.version, at(path, 'version')) }
    default: return fail(at(path, 'action'), 'unknown memory action')
  }
}
export const parseLeadMemoryProposal: Validator<LeadMemoryProposal> = (value, path = '') => {
  const item = only(['text', 'kind', 'source'])(value, path)
  const from = item.source === undefined ? undefined : only(['kind', 'id'])(item.source, at(path, 'source'))
  // A proposal may be longer than an entry: the desk tells the Lead it is too long rather than the wire refusing it.
  return { text: text(4096)(item.text, at(path, 'text')), kind: kind(item.kind, at(path, 'kind')),
    ...(from ? { source: { kind: literalUnion('message', 'result')(from.kind, at(path, 'source.kind')), id: text(256)(from.id, at(path, 'source.id')) } } : {}) }
}
export const parseLeadMemoryProposalResult: Validator<LeadMemoryProposalResult> = (value, path = '') => {
  const item = only(['outcome', 'id', 'reason'])(value, path)
  const outcome = literalUnion('inbox', 'kept', 'refused')(item.outcome, at(path, 'outcome'))
  const ref = optional(id)(item.id, at(path, 'id')), reason = optional(literalUnion(...LEAD_MEMORY_REFUSALS))(item.reason, at(path, 'reason'))
  return { outcome, ...(ref ? { id: ref } : {}), ...(reason ? { reason } : {}) }
}
export const parseLeadMemorySearch: Validator<LeadMemorySearch> = (value, path = '') => {
  const item = only(['query', 'limit'])(value, path)
  const limit = optional(count)(item.limit, at(path, 'limit'))
  if (limit !== undefined && (limit < 1 || limit > LEAD_MEMORY_LIMITS.results)) fail(at(path, 'limit'), `expected 1 to ${LEAD_MEMORY_LIMITS.results}`)
  return { query: text(LEAD_MEMORY_LIMITS.queryChars)(item.query, at(path, 'query')), ...(limit === undefined ? {} : { limit }) }
}
export const parseLeadMemorySearchResult: Validator<LeadMemorySearchResult> = (value, path = '') => {
  const item = only(['results'])(value, path)
  return { results: bounded((hit, where = ''): LeadMemoryHit => {
    const one = only(['text', 'at', 'date', 'source'])(hit, where), from = only(['kind', 'id', 'by'])(one.source, at(where, 'source'))
    const by = optional(literalUnion('person', 'lead', 'assistant'))(from.by, at(where, 'source.by'))
    return { text: text(LEAD_MEMORY_LIMITS.resultBytes)(one.text, at(where, 'text')), at: time(one.at, at(where, 'at')), date: text(32)(one.date, at(where, 'date')),
      source: { kind: literalUnion('memory', 'conversation', 'summary')(from.kind, at(where, 'source.kind')), id: text(256)(from.id, at(where, 'source.id')), ...(by ? { by } : {}) } }
  }, LEAD_MEMORY_LIMITS.results, 'results')(item.results, at(path, 'results')) }
}
