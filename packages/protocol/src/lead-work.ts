/**
 * The Lead's work ledger: one record per piece of work the person asked for, across the chats, Teams, pull requests
 * and issues it touches. The host owns every field except `note`, `after` and `remindAt`. A stage is derived from the
 * desk's own waiting-on-whom stages and is never written by the model. Titles, notes and facts are untrusted prose.
 */
import { arrayOf, isNumber, isObject, isString, literalUnion, optional, ValidationError, type Validator } from './validate.js'

export const LEAD_WORK_LIMITS = Object.freeze({
  /** Items kept in the ledger file, open and closed together. */
  items: 256,
  /** A closed item stays readable this long, then the ledger forgets it. */
  closedMs: 30 * 24 * 60 * 60 * 1000,
  /** Closed items the board shows under Done, and how far back they reach. */
  doneShown: 8,
  doneMs: 7 * 24 * 60 * 60 * 1000,
  titleChars: 120,
  noteChars: 300,
  factChars: 160,
  timeline: 24,
  linksPerKind: 16,
  /** The open cards that ride every Lead request, in UTF-8 bytes. */
  cardsBytes: 3072,
  /** The furthest a reminder may be set ahead. */
  remindMs: 30 * 24 * 60 * 60 * 1000,
  /** The nearest a reminder may be set: a reminder is never sooner than this from when it is set. */
  remindGapMs: 15 * 60 * 1000,
  /** Reminder wakes one item may have before the person writes again. */
  remindWakes: 3,
  /** An open item with no link the host can see for this long closes as stopped. */
  quietMs: 7 * 24 * 60 * 60 * 1000,
  idChars: 64,
} as const)

/**
 * One line of untrusted prose for a model's eyes: whitespace flattened, clipped, JSON-quoted, and `<` escaped, so it can
 * never close a surrounding block or pass for an instruction or a field. The request cards and reminder wakes both use it.
 */
export const quoteLeadWorkText = (text: string, max: number): string =>
  JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, max)).replace(/</g, '\\u003c')

export type LeadWorkStage = 'queued' | 'working' | 'needs-you' | 'in-review' | 'blocked' | 'done' | 'stopped'
export const LEAD_WORK_STAGES = ['queued', 'working', 'needs-you', 'in-review', 'blocked', 'done', 'stopped'] as const satisfies readonly LeadWorkStage[]
/** The four groups both surfaces draw, in this order: what needs the person comes first. */
export type LeadWorkGroup = 'needs-you' | 'working' | 'in-review' | 'done'
export const LEAD_WORK_GROUPS = ['needs-you', 'working', 'in-review', 'done'] as const satisfies readonly LeadWorkGroup[]
export const LEAD_WORK_GROUP_LABELS: Readonly<Record<LeadWorkGroup, string>> = Object.freeze({
  'needs-you': 'Needs you', working: 'Working', 'in-review': 'In review', done: 'Done',
})
export const leadWorkGroup = (stage: LeadWorkStage): LeadWorkGroup =>
  stage === 'needs-you' ? 'needs-you' : stage === 'in-review' ? 'in-review' : stage === 'done' || stage === 'stopped' ? 'done' : 'working'

export type LeadWorkOriginKind = 'person' | 'trigger' | 'mention' | 'repeat'
export interface LeadWorkOrigin {
  readonly kind: LeadWorkOriginKind
  /** What started it: a goal id, a trigger key, a mention's URL or a schedule slot. Left out for a plain request. */
  readonly ref?: string
  /** Ids of the person messages the work came from. */
  readonly quotes: readonly string[]
}
/** Chats are `runtime:session`, Teams their id, pull requests and issues `owner/repo#number`. */
export interface LeadWorkLinks {
  readonly chats: readonly string[]
  readonly teams: readonly string[]
  readonly prs: readonly string[]
  readonly issues: readonly string[]
}
export type LeadWorkOutcome = 'done' | 'dropped'
export interface LeadWorkCard {
  readonly id: string
  readonly title: string
  /** A project display name, never a path. */
  readonly project: string | null
  readonly stage: LeadWorkStage
  readonly group: LeadWorkGroup
  /** Why it waits, in the host's words. */
  readonly blocker?: string
  /** The latest thing the host saw happen to it, at most 160 characters. */
  readonly fact?: string
  readonly note?: string
  readonly after?: string
  readonly remindAt?: number
  readonly links: LeadWorkLinks
  readonly createdAt: number
  readonly updatedAt: number
  readonly closedAt?: number
  readonly outcome?: LeadWorkOutcome
}
/** Open items, then recently closed ones, grouped in `LEAD_WORK_GROUPS` order and newest first inside a group. */
export interface LeadWorkBoard {
  readonly version: 1
  readonly items: readonly LeadWorkCard[]
  /** Closed items left out of Done. */
  readonly more: number
}
export interface LeadWorkFact { readonly at: number; readonly text: string }
export interface LeadWorkDetail extends LeadWorkCard {
  readonly origin: LeadWorkOrigin
  readonly timeline: readonly LeadWorkFact[]
}
/** The model's only write. A null clears `after` or `remindAt`. */
export interface LeadWorkNote {
  readonly id: string
  readonly note?: string
  readonly after?: string | null
  readonly remindAt?: number | null
}
export interface LeadWorkClose { readonly id: string; readonly outcome: LeadWorkOutcome }

const fail = (path: string, message: string): never => { throw new ValidationError(path, message) }
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const text = (max: number, allowEmpty = false): Validator<string> => (value, path = '') => {
  const out = isString(value, path)
  if ((!allowEmpty && !out.trim()) || out.length > max || controls.test(out)) fail(path, `expected text up to ${max} characters`)
  return out
}
const workId: Validator<string> = (value, path = '') => {
  const out = isString(value, path)
  return /^work-[1-9][0-9]{0,8}$/.test(out) ? out : fail(path, 'expected a work id such as work-3')
}
const time: Validator<number> = (value, path = '') => {
  const out = isNumber(value, path)
  return Number.isSafeInteger(out) && out >= 0 ? out : fail(path, 'expected epoch milliseconds')
}
const only = (allowed: readonly string[]): Validator<Record<string, unknown>> => (value, path = '') => {
  const source = isObject(value, path)
  for (const key of Object.keys(source)) if (!allowed.includes(key)) fail(path, `unexpected field ${key}`)
  return source
}
const ids = (max: number): Validator<readonly string[]> => (value, path = '') => {
  const out = arrayOf(text(300))(value, path)
  return out.length <= max ? out : fail(path, `expected at most ${max} links`)
}
const links: Validator<LeadWorkLinks> = (value, path = '') => {
  const source = only(['chats', 'teams', 'prs', 'issues'])(value, path), at = (key: string) => path ? `${path}.${key}` : key
  return { chats: ids(LEAD_WORK_LIMITS.linksPerKind)(source.chats, at('chats')), teams: ids(LEAD_WORK_LIMITS.linksPerKind)(source.teams, at('teams')),
    prs: ids(LEAD_WORK_LIMITS.linksPerKind)(source.prs, at('prs')), issues: ids(LEAD_WORK_LIMITS.linksPerKind)(source.issues, at('issues')) }
}
const cardFields = ['id', 'title', 'project', 'stage', 'group', 'blocker', 'fact', 'note', 'after', 'remindAt', 'links', 'createdAt', 'updatedAt', 'closedAt', 'outcome']
const card = (source: Record<string, unknown>, path: string): LeadWorkCard => {
  const at = (key: string) => path ? `${path}.${key}` : key
  const stage = literalUnion(...LEAD_WORK_STAGES)(source.stage, at('stage'))
  const group = literalUnion(...LEAD_WORK_GROUPS)(source.group, at('group'))
  if (group !== leadWorkGroup(stage)) fail(at('group'), 'group does not follow the stage')
  const optionalText = (key: string, max: number) => optional(text(max))(source[key], at(key))
  const out: Record<string, unknown> = {
    id: workId(source.id, at('id')), title: text(LEAD_WORK_LIMITS.titleChars)(source.title, at('title')),
    project: source.project === null ? null : text(300)(source.project, at('project')), stage, group,
    blocker: optionalText('blocker', 200), fact: optionalText('fact', LEAD_WORK_LIMITS.factChars), note: optionalText('note', LEAD_WORK_LIMITS.noteChars),
    after: optional(workId)(source.after, at('after')), remindAt: optional(time)(source.remindAt, at('remindAt')),
    links: links(source.links, at('links')), createdAt: time(source.createdAt, at('createdAt')), updatedAt: time(source.updatedAt, at('updatedAt')),
    closedAt: optional(time)(source.closedAt, at('closedAt')), outcome: optional(literalUnion('done', 'dropped'))(source.outcome, at('outcome')),
  }
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
  return out as unknown as LeadWorkCard
}
export const parseLeadWorkCard: Validator<LeadWorkCard> = (value, path = '') => card(only(cardFields)(value, path), path)
export const parseLeadWorkBoard: Validator<LeadWorkBoard> = (value, path = '') => {
  const source = only(['version', 'items', 'more'])(value, path), at = (key: string) => path ? `${path}.${key}` : key
  if (source.version !== 1) fail(at('version'), 'unsupported work board version')
  const items = arrayOf(parseLeadWorkCard)(source.items, at('items'))
  if (items.length > LEAD_WORK_LIMITS.items) fail(at('items'), 'too many work items')
  return { version: 1, items, more: time(source.more, at('more')) }
}
export const parseLeadWorkDetail: Validator<LeadWorkDetail> = (value, path = '') => {
  const source = only([...cardFields, 'origin', 'timeline'])(value, path), at = (key: string) => path ? `${path}.${key}` : key
  const origin = only(['kind', 'ref', 'quotes'])(source.origin, at('origin'))
  const quotes = arrayOf(text(256))(origin.quotes, at('origin.quotes'))
  const timeline = arrayOf((entry, where = '') => {
    const fact = only(['at', 'text'])(entry, where)
    return { at: time(fact.at, `${where}.at`), text: text(LEAD_WORK_LIMITS.factChars)(fact.text, `${where}.text`) }
  })(source.timeline, at('timeline'))
  if (timeline.length > LEAD_WORK_LIMITS.timeline) fail(at('timeline'), 'too many timeline entries')
  const ref = optional(text(300))(origin.ref, at('origin.ref'))
  return { ...card(source, path), origin: { kind: literalUnion('person', 'trigger', 'mention', 'repeat')(origin.kind, at('origin.kind')), ...(ref === undefined ? {} : { ref }), quotes }, timeline }
}
/** Wire params for `lead/work/note`; at least one field besides `id`. */
export const parseLeadWorkNote: Validator<LeadWorkNote> = (value, path = '') => {
  const source = only(['id', 'note', 'after', 'remindAt'])(value, path), at = (key: string) => path ? `${path}.${key}` : key
  const out: { id: string; note?: string; after?: string | null; remindAt?: number | null } = { id: workId(source.id, at('id')) }
  if (source.note !== undefined) out.note = text(LEAD_WORK_LIMITS.noteChars, true)(source.note, at('note'))
  if (source.after !== undefined) out.after = source.after === null ? null : workId(source.after, at('after'))
  if (source.remindAt !== undefined) out.remindAt = source.remindAt === null ? null : time(source.remindAt, at('remindAt'))
  if (out.note === undefined && out.after === undefined && out.remindAt === undefined) fail(path, 'expected note, after or remindAt')
  if (out.after === out.id) fail(at('after'), 'an item cannot wait for itself')
  return out
}
export const parseLeadWorkClose: Validator<LeadWorkClose> = (value, path = '') => {
  const source = only(['id', 'outcome'])(value, path), at = (key: string) => path ? `${path}.${key}` : key
  return { id: workId(source.id, at('id')), outcome: literalUnion('done', 'dropped')(source.outcome, at('outcome')) }
}
export const parseLeadWorkList: Validator<{ readonly state?: 'open' | 'all' }> = (value, path = '') => {
  const source = only(['state'])(value, path)
  return source.state === undefined ? {} : { state: literalUnion('open', 'all')(source.state, path ? `${path}.state` : 'state') }
}
export const parseLeadWorkRead: Validator<{ readonly id: string }> = (value, path = '') =>
  ({ id: workId(only(['id'])(value, path).id, path ? `${path}.id` : 'id') })
