/**
 * Presence: what changed while a device was away, and what became of each question the Lead asked.
 *
 * The host owns every field. A device (the window, each paired phone) only says who it is and whether it is looking;
 * the digest, the expiry of an ask and the receipt of an answer are computed here, once, so every surface draws the
 * same thing. Titles and facts are untrusted prose; the summary paragraph is the observer model's words.
 */
import { arrayOf, isBoolean, isNumber, isObject, isString, literalUnion, optional, ValidationError, type Validator } from './validate.js'

/**
 * The words for the items a digest had no room for. Dismissing a digest dismisses its whole span, these included, so
 * every surface says so in the same words rather than letting them go unseen.
 */
export const leadDigestMore = (more: number): string => `${more} more not shown; dismissing clears them too`

export const LEAD_PRESENCE_LIMITS = Object.freeze({
  /** Away this long and the next look gets a digest. A shorter absence is a glance. */
  awayMs: 30 * 60_000,
  /** The furthest back an on-demand "What happened?" reaches when the device has never been seen. */
  recapMs: 24 * 60 * 60_000,
  /** Items a digest lists; the rest are counted. */
  items: 8,
  /** The observer model writes a paragraph only when at least this many items changed. */
  summaryItems: 3,
  titleChars: 120,
  factChars: 160,
  summaryChars: 400,
  /** Longest an ask may stay open, and the shortest. */
  expiryMinMinutes: 5,
  expiryMaxMinutes: 7 * 24 * 60,
  devices: 16,
  asks: 64,
  deviceChars: 64,
  labelChars: 40,
} as const)

/** Where a push is read: a paired phone's lock screen, or the desktop's own notice. */
export type LeadPushTransport = 'phone' | 'window'
/** Characters, per transport, that a push may carry. The phone's numbers are the sealed push body's (`PushPlaintext`). */
export const LEAD_PUSH_CAPS: Readonly<Record<LeadPushTransport, { readonly title: number; readonly body: number }>> = Object.freeze({
  phone: Object.freeze({ title: 80, body: 240 }),
  window: Object.freeze({ title: 80, body: 400 }),
})
/** One flat line that fits the transport: controls and runs of space removed, clipped with an ellipsis. */
export const capLeadPushText = (transport: LeadPushTransport, text: { readonly title: string; readonly body: string }): { readonly title: string; readonly body: string } => {
  const flat = (value: string, max: number) => {
    const clean = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim()
    const chars = [...clean]
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : clean
  }
  const caps = LEAD_PUSH_CAPS[transport]
  return { title: flat(text.title, caps.title), body: flat(text.body, caps.body) }
}

/** A device that looks at the Lead: `window:<id>` is a desktop window, `phone:<id>` a paired phone. */
export interface LeadDeviceRef {
  readonly id: string
  /** What a receipt calls it: "Desktop", or the phone's name. */
  readonly label: string
}
const deviceId = /^(window|phone):[A-Za-z0-9._-]{1,48}$/
const fail = (path: string, message: string): never => { throw new ValidationError(path, message) }
const controls = /[\p{Cc}\p{Zl}\p{Zp}]/u
const text = (max: number, allowEmpty = false): Validator<string> => (value, path = '') => {
  const out = isString(value, path)
  if ((!allowEmpty && !out.trim()) || out.length > max || controls.test(out)) fail(path, `expected one line of text up to ${max} characters`)
  return out
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
const at = (path: string, key: string) => path ? `${path}.${key}` : key
export const parseLeadDeviceRef: Validator<LeadDeviceRef> = (value, path = '') => {
  const source = only(['id', 'label'])(value, path)
  const id = isString(source.id, at(path, 'id'))
  if (!deviceId.test(id)) fail(at(path, 'id'), 'expected window:<id> or phone:<id>')
  return { id, label: text(LEAD_PRESENCE_LIMITS.labelChars)(source.label, at(path, 'label')) }
}

export type LeadDigestKind = 'away' | 'recap' | 'brief'
export type LeadDigestItemKind = 'done' | 'waiting' | 'stopped'
export const LEAD_DIGEST_ITEM_LABELS: Readonly<Record<LeadDigestItemKind, string>> = Object.freeze({ done: 'Done', waiting: 'Needs you', stopped: 'Stopped or stuck' })
export interface LeadDigestItem {
  readonly kind: LeadDigestItemKind
  /** A work item id (`work-3`) or a card id; opens the same thing on every surface. */
  readonly id: string
  readonly title: string
  /** The evidence line: the latest thing the host saw happen. */
  readonly fact?: string
  /** Where the item opens: the chat, Team or pull request that is the evidence, the work item, or the decision card. */
  readonly ref?: LeadDigestRef
  /** When the change the item reports happened, epoch milliseconds. */
  readonly at?: number
  /** Who stopped a stopped item, when the host saw who did: the person (window or phone) or the Lead. Absent: not known. */
  readonly stoppedBy?: LeadStopActor
}
/** Who stopped a chat: the person, from any surface, or the Lead. */
export type LeadStopActor = 'person' | 'lead'
export type LeadDigestRefKind = 'chat' | 'team' | 'pr' | 'work' | 'card'
/**
 * What a digest item opens. `chat` is `runtime:session`, `team` a Team id, `pr` `owner/repo#number`, `work` a work item
 * id and `card` a decision card in the Lead conversation. A surface draws a link only for what it can find itself.
 */
export interface LeadDigestRef { readonly kind: LeadDigestRefKind; readonly id: string }
export interface LeadDigest {
  readonly version: 1
  /** Stable for one digest on one device, so a dismissal names exactly what was seen. A dismissal clears it on every device. */
  readonly id: string
  readonly kind: LeadDigestKind
  readonly from: number
  readonly to: number
  readonly items: readonly LeadDigestItem[]
  /** Items beyond the eight listed. */
  readonly more: number
  /** Lead and worker spend since `from`, in micro-dollars. */
  readonly spentUsdMicros: number
  /** The observer model's paragraph; present only when at least three items changed. */
  readonly summary?: string
  /** What that paragraph cost, counted in the spend above. */
  readonly summaryUsdMicros?: number
}
export type LeadAskStatus = 'open' | 'answered' | 'expired'
/** What became of one question the Lead asked, by the id of the message that carried it. */
export interface LeadAskState {
  readonly id: string
  readonly status: LeadAskStatus
  readonly expiresAt?: number
  /** Present once answered: the option's label, the device's label and when. */
  readonly answer?: { readonly option: string; readonly by: string; readonly at: number }
}
export interface LeadBriefSettings { readonly enabled: boolean; readonly at: string }
export interface LeadPresenceView {
  readonly version: 1
  readonly digest: LeadDigest | null
  readonly asks: readonly LeadAskState[]
  readonly brief: LeadBriefSettings
}
/** One push, capped for each place it is read. */
export interface LeadPushNotice {
  readonly digest: string
  readonly phone: { readonly title: string; readonly body: string }
  readonly window: { readonly title: string; readonly body: string }
}
export interface LeadPresenceRead { readonly device: LeadDeviceRef; readonly active?: boolean; readonly recap?: boolean }
export interface LeadPresenceDismiss { readonly device: LeadDeviceRef; readonly digest: string }
export interface LeadBriefUpdate { readonly enabled?: boolean; readonly at?: string }

export const parseLeadPresenceRead: Validator<LeadPresenceRead> = (value, path = '') => {
  const source = only(['device', 'active', 'recap'])(value, path)
  return { device: parseLeadDeviceRef(source.device, at(path, 'device')),
    ...(source.active === undefined ? {} : { active: isBoolean(source.active, at(path, 'active')) }),
    ...(source.recap === undefined ? {} : { recap: isBoolean(source.recap, at(path, 'recap')) }) }
}
export const parseLeadPresenceDismiss: Validator<LeadPresenceDismiss> = (value, path = '') => {
  const source = only(['device', 'digest'])(value, path)
  return { device: parseLeadDeviceRef(source.device, at(path, 'device')), digest: text(96)(source.digest, at(path, 'digest')) }
}
const clock: Validator<string> = (value, path = '') => {
  const out = isString(value, path)
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(out)
  return match ? out : fail(path, 'expected a time such as 07:30')
}
export const parseLeadBriefSettings: Validator<LeadBriefSettings> = (value, path = '') => {
  const source = only(['enabled', 'at'])(value, path)
  return { enabled: isBoolean(source.enabled, at(path, 'enabled')), at: clock(source.at, at(path, 'at')) }
}
export const parseLeadBriefUpdate: Validator<LeadBriefUpdate> = (value, path = '') => {
  const source = only(['enabled', 'at'])(value, path)
  const out: { enabled?: boolean; at?: string } = {}
  if (source.enabled !== undefined) out.enabled = isBoolean(source.enabled, at(path, 'enabled'))
  if (source.at !== undefined) out.at = clock(source.at, at(path, 'at'))
  if (out.enabled === undefined && out.at === undefined) fail(path, 'expected enabled or at')
  return out
}
/** A pull request as `owner/repo#n`. Neither name may be `.` or `..`, so the id never walks a path when it becomes a link. */
export const LEAD_PULL_REQUEST_REF = /^((?!\.{1,2}\/)[\w.-]{1,100})\/((?!\.{1,2}#)[\w.-]{1,100})#([1-9]\d{0,9})$/
/** Whether `id` is a well-formed id for a digest link of this kind: what the host sends and what a reader opens. */
export const isLeadDigestRefId = (kind: LeadDigestRefKind, id: string): boolean => id.length <= 300 && (
  kind === 'pr' ? LEAD_PULL_REQUEST_REF.test(id) : kind === 'chat' ? /^[\w.-]{1,64}:[^\s\u0000-\u001f\u007f]{1,235}$/.test(id) : /^[\w.:-]{1,200}$/.test(id))
const digestRef: Validator<LeadDigestRef> = (value, path = '') => {
  const source = only(['kind', 'id'])(value, path)
  const kind = literalUnion('chat', 'team', 'pr', 'work', 'card')(source.kind, at(path, 'kind')), id = text(300)(source.id, at(path, 'id'))
  return isLeadDigestRefId(kind, id) ? { kind, id } : fail(at(path, 'id'), `expected a ${kind} id`)
}
const ITEM_FIELDS = ['kind', 'id', 'title', 'fact', 'ref', 'at', 'stoppedBy'] as const
const DIGEST_FIELDS = ['version', 'id', 'kind', 'from', 'to', 'items', 'more', 'spentUsdMicros', 'summary', 'summaryUsdMicros'] as const
const item: Validator<LeadDigestItem> = (value, path = '') => {
  const source = only([...ITEM_FIELDS])(value, path)
  const fact = optional(text(LEAD_PRESENCE_LIMITS.factChars))(source.fact, at(path, 'fact'))
  const ref = optional(digestRef)(source.ref, at(path, 'ref'))
  const when = optional(time)(source.at, at(path, 'at'))
  const stoppedBy = optional(literalUnion('person', 'lead'))(source.stoppedBy, at(path, 'stoppedBy'))
  return { kind: literalUnion('done', 'waiting', 'stopped')(source.kind, at(path, 'kind')), id: text(96)(source.id, at(path, 'id')),
    title: text(LEAD_PRESENCE_LIMITS.titleChars)(source.title, at(path, 'title')), ...(fact === undefined ? {} : { fact }),
    ...(ref === undefined ? {} : { ref }), ...(when === undefined ? {} : { at: when }), ...(stoppedBy === undefined ? {} : { stoppedBy }) }
}
export const parseLeadDigest: Validator<LeadDigest> = (value, path = '') => {
  const source = only([...DIGEST_FIELDS])(value, path)
  if (source.version !== 1) fail(at(path, 'version'), 'unsupported digest version')
  const items = arrayOf(item)(source.items, at(path, 'items'))
  if (items.length > LEAD_PRESENCE_LIMITS.items) fail(at(path, 'items'), 'too many digest items')
  const summary = optional(text(LEAD_PRESENCE_LIMITS.summaryChars))(source.summary, at(path, 'summary'))
  const summaryUsdMicros = optional(time)(source.summaryUsdMicros, at(path, 'summaryUsdMicros'))
  return { version: 1, id: text(96)(source.id, at(path, 'id')), kind: literalUnion('away', 'recap', 'brief')(source.kind, at(path, 'kind')),
    from: time(source.from, at(path, 'from')), to: time(source.to, at(path, 'to')), items, more: time(source.more, at(path, 'more')),
    spentUsdMicros: time(source.spentUsdMicros, at(path, 'spentUsdMicros')),
    ...(summary === undefined ? {} : { summary }), ...(summaryUsdMicros === undefined ? {} : { summaryUsdMicros }) }
}
/**
 * A digest read back from the host's own record, written by this host or another version of it. Fields this version does
 * not know are left out, and an item or link it cannot read is dropped, so a record from a newer or older host keeps the
 * rest of what it holds. Throws only when the digest itself cannot be read.
 */
export const parseStoredLeadDigest = (value: unknown): LeadDigest => {
  const pick = (source: unknown, keys: readonly string[]): Record<string, unknown> =>
    source && typeof source === 'object' && !Array.isArray(source) ? Object.fromEntries(keys.filter(key => key in source).map(key => [key, (source as Record<string, unknown>)[key]])) : {}
  const top = pick(value, DIGEST_FIELDS)
  const items = (Array.isArray(top.items) ? top.items : []).flatMap(entry => {
    const known = pick(entry, ITEM_FIELDS)
    // Whole first, then without its link, then as an older host wrote it.
    for (const drop of [[], ['ref'], ['ref', 'at', 'stoppedBy']]) {
      const tried = Object.fromEntries(Object.entries(known).filter(([key]) => !drop.includes(key)))
      try { return [item(tried.ref === undefined ? tried : { ...tried, ref: pick(tried.ref, ['kind', 'id']) })] } catch { /* Try with less. */ }
    }
    return []
  })
  return parseLeadDigest({ ...top, items: items.slice(0, LEAD_PRESENCE_LIMITS.items) })
}
const askState: Validator<LeadAskState> = (value, path = '') => {
  const source = only(['id', 'status', 'expiresAt', 'answer'])(value, path)
  const expiresAt = optional(time)(source.expiresAt, at(path, 'expiresAt'))
  let answer: LeadAskState['answer']
  if (source.answer !== undefined) {
    const a = only(['option', 'by', 'at'])(source.answer, at(path, 'answer'))
    answer = { option: text(60)(a.option, at(path, 'answer.option')), by: text(LEAD_PRESENCE_LIMITS.labelChars)(a.by, at(path, 'answer.by')), at: time(a.at, at(path, 'answer.at')) }
  }
  return { id: text(64)(source.id, at(path, 'id')), status: literalUnion('open', 'answered', 'expired')(source.status, at(path, 'status')),
    ...(expiresAt === undefined ? {} : { expiresAt }), ...(answer ? { answer } : {}) }
}
export const parseLeadPresenceView: Validator<LeadPresenceView> = (value, path = '') => {
  const source = only(['version', 'digest', 'asks', 'brief'])(value, path)
  if (source.version !== 1) fail(at(path, 'version'), 'unsupported presence version')
  const asks = arrayOf(askState)(source.asks, at(path, 'asks'))
  if (asks.length > LEAD_PRESENCE_LIMITS.asks) fail(at(path, 'asks'), 'too many asks')
  return { version: 1, digest: source.digest === null ? null : parseLeadDigest(source.digest, at(path, 'digest')), asks, brief: parseLeadBriefSettings(source.brief, at(path, 'brief')) }
}
/** A short line for a push: what changed, in counts. Never model prose. */
export const leadDigestPushText = (digest: LeadDigest, name: string): { readonly title: string; readonly body: string } => {
  const count = (kind: LeadDigestItemKind) => digest.items.filter(entry => entry.kind === kind).length + 0
  const parts = [count('waiting') && `${count('waiting')} need${count('waiting') === 1 ? 's' : ''} you`, count('done') && `${count('done')} done`, count('stopped') && `${count('stopped')} stopped`].filter(Boolean)
  return { title: digest.kind === 'brief' ? `${name}: morning brief` : `${name}: while you were away`, body: parts.length ? parts.join(', ') : 'Nothing new.' }
}
