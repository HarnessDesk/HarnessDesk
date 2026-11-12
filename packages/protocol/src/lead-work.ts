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
  /** A reminder's own words: what the person or the Lead is reminded of. */
  reminderChars: 200,
  /** Reminders set and not yet due, for the person and the Lead together. */
  remindersSet: 20,
  /** The nearest a reminder for the person may be set: a minute from when it is set. */
  reminderGapMs: 60 * 1000,
  /** A fired or cancelled reminder stays on the board this long, and in the file a week. */
  reminderShownMs: 24 * 60 * 60 * 1000,
  reminderKeptMs: 7 * 24 * 60 * 60 * 1000,
  /** A previous attempt the host stopped this recently still counts as the same work, so a new start asks first. */
  retryMs: 24 * 60 * 60 * 1000,
  /** Stopped attempts an item keeps, newest kept. */
  stopsKept: 8,
  /** Stopped attempts after which the host refuses another until the person answers the Lead's question. */
  stopsBeforeAsking: 1,
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
  /** Who stopped it, for an item that closed because its chat was stopped and the host saw who stopped it. */
  readonly stoppedBy?: 'person' | 'lead'
  /**
   * Each attempt under this item that ended because its chat was stopped, oldest first, at most
   * `LEAD_WORK_LIMITS.stopsKept`; `by` is left out when the host did not see who stopped it. Left out when none was.
   */
  readonly stops?: readonly LeadWorkStop[]
}
/** One stopped attempt: when the host saw it stopped, and who stopped it when the host saw that. */
export interface LeadWorkStop { readonly at: number; readonly by?: 'person' | 'lead' }
/** Open items, then recently closed ones, grouped in `LEAD_WORK_GROUPS` order and newest first inside a group. */
export interface LeadWorkBoard {
  readonly version: 1
  readonly items: readonly LeadWorkCard[]
  /** Closed items left out of Done. */
  readonly more: number
  /**
   * Every reminder still set, soonest first, then the ones that fired or were cancelled in the last day, newest first.
   * Left out when there are none.
   */
  readonly reminders?: readonly LeadReminder[]
  /**
   * The Lead's own question the desk holds open, when the board is read for the Lead's context: the one ask the presence
   * record says is `open`, newest first replacing older ones. Left out when none is open, and on the board a window or
   * the phone reads; they follow `lead/presence/read`'s `asks` instead.
   */
  readonly ask?: LeadWorkAsk
}
/** The open question as the Lead is told it: the message that carries it, its words, when the desk first saw it. */
export interface LeadWorkAsk {
  readonly id: string
  readonly question: string
  readonly at: number
  /** When it stops being answerable. Left out: it does not expire. */
  readonly expiresAt?: number
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
const stops: Validator<readonly LeadWorkStop[]> = (value, path = '') => {
  const out = arrayOf((one, where = '') => {
    const source = only(['at', 'by'])(one, where), at = (key: string) => where ? `${where}.${key}` : key
    return { at: time(source.at, at('at')), ...(source.by === undefined ? {} : { by: literalUnion('person', 'lead')(source.by, at('by')) }) }
  })(value, path)
  return out.length <= LEAD_WORK_LIMITS.stopsKept ? out : fail(path, `expected at most ${LEAD_WORK_LIMITS.stopsKept} stops`)
}
const cardFields = ['id', 'title', 'project', 'stage', 'group', 'blocker', 'fact', 'note', 'after', 'remindAt', 'links', 'createdAt', 'updatedAt', 'closedAt', 'outcome', 'stoppedBy', 'stops']
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
    stoppedBy: optional(literalUnion('person', 'lead'))(source.stoppedBy, at('stoppedBy')),
    stops: source.stops === undefined ? undefined : stops(source.stops, at('stops')),
  }
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
  return out as unknown as LeadWorkCard
}
export const parseLeadWorkCard: Validator<LeadWorkCard> = (value, path = '') => card(only(cardFields)(value, path), path)
export const parseLeadWorkBoard: Validator<LeadWorkBoard> = (value, path = '') => {
  const source = only(['version', 'items', 'more', 'reminders', 'ask'])(value, path), at = (key: string) => path ? `${path}.${key}` : key
  if (source.version !== 1) fail(at('version'), 'unsupported work board version')
  const ask = source.ask === undefined ? undefined : parseLeadWorkAsk(source.ask, at('ask'))
  const items = arrayOf(parseLeadWorkCard)(source.items, at('items'))
  if (items.length > LEAD_WORK_LIMITS.items) fail(at('items'), 'too many work items')
  const reminders = source.reminders === undefined ? undefined : arrayOf(parseLeadReminder)(source.reminders, at('reminders'))
  if (reminders && reminders.length > LEAD_WORK_LIMITS.remindersSet * 2) fail(at('reminders'), 'too many reminders')
  return { version: 1, items, more: time(source.more, at('more')), ...(reminders?.length ? { reminders } : {}), ...(ask ? { ask } : {}) }
}
const parseLeadWorkAsk: Validator<LeadWorkAsk> = (value, path = '') => {
  const source = only(['id', 'question', 'at', 'expiresAt'])(value, path), at = (key: string) => `${path}.${key}`
  const question = text(800)(source.question, at('question'))
  if (/[\r\n]/.test(question)) fail(at('question'), 'expected one line')
  const expiresAt = source.expiresAt === undefined ? undefined : time(source.expiresAt, at('expiresAt'))
  return { id: text(256)(source.id, at('id')), question, at: time(source.at, at('at')), ...(expiresAt === undefined ? {} : { expiresAt }) }
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

/**
 * A reminder as a scheduled entry the person can see and cancel. `person` reminders are ones the person asked for: when
 * due they wake the Lead to tell the person. `lead` reminders are the Lead's own: an item's check-back, set through
 * `lead/work/note` (`kind: 'check-back'`), or one set in a turn no person's message woke. Only `fired` means it arrived;
 * a `set` one has not, however close its time.
 */
export type LeadReminderState = 'set' | 'fired' | 'cancelled'
export interface LeadReminder {
  /** `remind-<n>`. */
  readonly id: string
  /** Untrusted prose: what to remind of, at most 200 characters. */
  readonly text: string
  readonly for: 'person' | 'lead'
  /** The work item it is about, when it is about one. */
  readonly item?: string
  readonly dueAt: number
  readonly createdAt: number
  readonly state: LeadReminderState
  readonly firedAt?: number
  readonly cancelledAt?: number
  /** Why it ended without firing, in the host's words. */
  readonly why?: string
  /**
   * `check-back` marks the one check-back an item has, set through `lead/work/note`: a new time replaces it, it is the
   * card's `remindAt`, and its wakes count toward the item's cap. Left out for a reminder set through `lead/reminder/set`,
   * even a `lead` one on an item.
   */
  readonly kind?: 'check-back'
  /**
   * A fired `person` reminder only: `said` once the Lead's message about it is written in the thread, `missed` when its
   * wake (and one more try) ended without one. Left out while that is not known yet, and for the Lead's own reminders,
   * whose wake may rightly end in silence. `fired` alone means the Lead was woken, never that the person was told.
   */
  readonly delivery?: 'said' | 'missed'
  /** When `delivery` was settled. */
  readonly deliveredAt?: number
}
const reminderId: Validator<string> = (value, path = '') => {
  const out = isString(value, path)
  return /^remind-[1-9][0-9]{0,8}$/.test(out) ? out : fail(path, 'expected a reminder id such as remind-3')
}
export const parseLeadReminder: Validator<LeadReminder> = (value, path = '') => {
  const source = only(['id', 'text', 'for', 'item', 'dueAt', 'createdAt', 'state', 'firedAt', 'cancelledAt', 'why', 'kind', 'delivery', 'deliveredAt'])(value, path)
  const at = (key: string) => path ? `${path}.${key}` : key
  const out: Record<string, unknown> = {
    id: reminderId(source.id, at('id')), text: text(LEAD_WORK_LIMITS.reminderChars)(source.text, at('text')),
    for: literalUnion('person', 'lead')(source.for, at('for')), item: optional(workId)(source.item, at('item')),
    dueAt: time(source.dueAt, at('dueAt')), createdAt: time(source.createdAt, at('createdAt')),
    state: literalUnion('set', 'fired', 'cancelled')(source.state, at('state')),
    firedAt: optional(time)(source.firedAt, at('firedAt')), cancelledAt: optional(time)(source.cancelledAt, at('cancelledAt')),
    why: optional(text(200))(source.why, at('why')), kind: optional(literalUnion('check-back'))(source.kind, at('kind')),
    delivery: optional(literalUnion('said', 'missed'))(source.delivery, at('delivery')), deliveredAt: optional(time)(source.deliveredAt, at('deliveredAt')),
  }
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
  return out as unknown as LeadReminder
}
/**
 * Wire params for `lead/reminder/set`: the Lead sets a reminder the person asked for, either `inMinutes` from now or
 * `at` epoch milliseconds, exactly one of them.
 */
export interface LeadReminderSet {
  readonly text: string; readonly at?: number; readonly inMinutes?: number; readonly item?: string
  /** What woke the turn, added by the Lead's own dispatcher, never by the model: only `person` sets the person's reminder. */
  readonly cause?: 'person' | 'automatic'
}
export const parseLeadReminderSet: Validator<LeadReminderSet> = (value, path = '') => {
  const source = only(['text', 'at', 'inMinutes', 'item', 'cause'])(value, path), at = (key: string) => path ? `${path}.${key}` : key
  const item = optional(workId)(source.item, at('item'))
  const cause = optional(literalUnion('person', 'automatic'))(source.cause, at('cause'))
  const when = optional(time)(source.at, at('at'))
  const minutes = optional(time)(source.inMinutes, at('inMinutes'))
  if ((when === undefined) === (minutes === undefined)) fail(path, 'expected exactly one of at or inMinutes')
  if (minutes !== undefined && (minutes < 1 || minutes > LEAD_WORK_LIMITS.remindMs / 60_000)) fail(at('inMinutes'), 'expected 1 to 43200 minutes')
  return { text: text(LEAD_WORK_LIMITS.reminderChars)(source.text, at('text')), ...(when === undefined ? {} : { at: when }),
    ...(minutes === undefined ? {} : { inMinutes: minutes }), ...(item === undefined ? {} : { item }), ...(cause === undefined ? {} : { cause }) }
}
/** Wire params for `lead/reminder/cancel` (from the Lead, the window or the phone) and `lead/reminder/clear` (the person's). */
export const parseLeadReminderCancel: Validator<{ readonly id: string }> = (value, path = '') =>
  ({ id: reminderId(only(['id'])(value, path).id, path ? `${path}.id` : 'id') })

/**
 * Who stopped an item's attempts, said to the Lead: "the person stopped it each time", "you stopped it each time", or
 * the count for each actor, with the stops whose actor the host did not see named as such. Never guesses.
 */
export const leadStopTally = (stops: readonly LeadWorkStop[]): string => {
  const person = stops.filter(stop => stop.by === 'person').length, lead = stops.filter(stop => stop.by === 'lead').length
  const unseen = stops.length - person - lead
  const times = (n: number) => n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`
  if (person === stops.length) return stops.length === 1 ? 'the person stopped it' : 'the person stopped it each time'
  if (lead === stops.length) return stops.length === 1 ? 'you stopped it' : 'you stopped it each time'
  if (unseen === stops.length) return 'the desk did not see who stopped it'
  return [person ? `the person stopped it ${times(person)}` : '', lead ? `you stopped it ${times(lead)}` : '',
    unseen ? `${times(unseen)} the desk did not see who` : ''].filter(Boolean).join(', ')
}
