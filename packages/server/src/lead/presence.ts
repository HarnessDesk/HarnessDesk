import type { LeadState } from '@harnessdesk/lead'
import { LEAD_PRESENCE_LIMITS, capLeadPushText, quoteLeadWorkText, leadDigestPushText, parseLeadBriefSettings, parseLeadDigest, parseLeadPresenceView, parseStoredLeadDigest, isLeadDigestRefId,
  type LeadAsk, type LeadAskState, type LeadBriefSettings, type LeadBriefUpdate, type LeadDeviceRef, type LeadDigest, type LeadDigestItem,
  type LeadDigestKind, type LeadDigestRef, type LeadPresenceView, type LeadWorkBoard, type LeadWorkCard } from '@harnessdesk/protocol'
import { rename } from 'node:fs/promises'
import { readBoundedJsonResult, writeAtomicJson } from './bounded-json.js'

/** The most the observer model may cost in a day, in micro-dollars: one short paragraph is a fraction of a cent. */
export const LEAD_DIGEST_OBSERVER_DAILY_MICROS = 20_000
const MAX_BYTES = 512 * 1024
/** A morning brief stays on offer this long if nobody dismisses it. */
const BRIEF_LIFE_MS = 18 * 60 * 60_000

export interface LeadPresencePorts {
  readonly file: string
  readonly now: () => number
  /** Lead and worker spend so far, in micro-dollars. */
  readonly spent: () => number
  /** The work ledger, closed items included. */
  readonly board: () => Promise<LeadWorkBoard>
  /** Decisions the person has not made, from the journal. `position` is the revision they appeared at. */
  readonly waiting: () => readonly { readonly id: string; readonly title: string; readonly position: number }[]
  readonly revision: () => number
  /** The thread's messages, for the asks among them. */
  readonly messages: () => readonly { readonly id: string; readonly role: string; readonly text: string; readonly ask?: LeadAsk; readonly source?: 'person' | 'automatic' | 'schedule'; readonly wake?: unknown }[]
  /** Whether quiet hours hold work back right now. */
  readonly quiet: () => Promise<boolean>
  /** Autonomy for the morning brief: `off` and `observed` both mean it is not made; the day is spent either way. */
  readonly briefGate?: () => Promise<'act' | 'off' | 'observed'>
  readonly name: () => string
  /** The observer model's paragraph over the changed items, and what it cost. Absent or null: no paragraph. */
  readonly observe?: (input: { readonly items: readonly LeadDigestItem[]; readonly from: number; readonly to: number }) => Promise<{ readonly text: string; readonly usdMicros: number } | null>
  /** One push, already capped for each transport. */
  readonly push?: (notice: { readonly digest: string; readonly phone: { readonly title: string; readonly body: string }; readonly window: { readonly title: string; readonly body: string } }) => void
  /** Presence changed for every device (the brief arrived, an ask moved, or a digest was dismissed). */
  readonly changed?: () => void
}

interface Mark {
  label: string
  seenAt: number
  revision: number
  spent: number
  /** The digest this device has not dismissed, and the journal revision and spend where it ends. */
  pending?: LeadDigest
  pendingEnd?: { revision: number; spent: number }
  /** Where the latest digest began, for "What happened?" and its spend. */
  last?: { from: number; spent: number; revision: number }
  /** The id of the brief this device dismissed, from before a dismissal was the desk's. */
  briefDone?: string
}
/**
 * What the person dismissed, on whichever device: the span the digest covered, `from` to `at`, and the journal revision
 * and spend where it ended. That span counts as seen on every device; what changed after it is still told.
 */
interface Seen { from: number; at: number; revision: number; spent: number }
interface Plan { replaces?: string; baseline?: { from: number; spent: number; revision: number }; end?: { revision: number; spent: number }; kind: LeadDigestKind; from: number; to: number; items: LeadDigestItem[]; more: number; spent: number }
/** How long a question with no expiry of its own holds the work it decides. */
export const LEAD_ASK_HOLD_MS = 24 * 60 * 60_000

interface AskRecord { seenAt: number; expiresAt?: number; answer?: { option: string; by: string; at: number } }
interface Stored {
  version: 1
  devices: Record<string, Mark>
  asks: Record<string, AskRecord>
  brief: LeadBriefSettings
  /** The local day a brief last went out, `YYYY-MM-DD`. */
  briefDay?: string
  briefDigest?: LeadDigest
  /** Spend and journal revision when the last brief was built, so the next one counts from there. */
  briefSpent?: number
  briefRevision?: number
  observer: { day: string; usdMicros: number }
  /** When this record began, with the spend then, so the first brief counts from a real starting point. */
  origin?: { at: number; spent: number }
  /** The spans of away digests and recaps dismissed on any device, oldest first; spans that meet are joined. */
  seen?: Seen[]
  /** The id of the brief the person dismissed, on any device. */
  briefDone?: string
}
const fresh = (): Stored => ({ version: 1, devices: {}, asks: {}, brief: { enabled: false, at: '07:30' }, observer: { day: '', usdMicros: 0 } })
const dayOf = (at: number) => { const date = new Date(at); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
/** What a work item opens: what is done opens its evidence (pull request, then Team, then chat); anything else opens where it is happening. */
const digestRef = (card: LeadWorkCard): LeadDigestRef => {
  const last = (list: readonly string[]) => list[list.length - 1]
  const pr = last(card.links.prs), team = last(card.links.teams), chat = last(card.links.chats)
  const order: [LeadDigestRef['kind'], string | undefined][] = card.stage === 'done'
    ? [['pr', pr], ['team', team], ['chat', chat]]
    : [['team', team], ['chat', chat], ['pr', pr]]
  const found = order.find(([kind, id]) => id && isLeadDigestRefId(kind, id))
  return found ? { kind: found[0], id: found[1]! } : { kind: 'work', id: card.id }
}
const stored = (value: unknown): LeadDigest | undefined => { if (value === undefined) return undefined; try { return parseStoredLeadDigest(value) } catch { return undefined } }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const validEnd = (value: unknown): value is { revision: number; spent: number } => !!value && finite((value as { revision: unknown }).revision) && finite((value as { spent: unknown }).spent)
const SEEN_SPANS = 8
const seenSpans = (value: unknown): Seen[] => (Array.isArray(value) ? value : []).flatMap(entry => {
  const seen = entry as Partial<Seen> | null
  return seen && finite(seen.from) && finite(seen.at) && finite(seen.revision) && finite(seen.spent) ? [{ from: seen.from, at: seen.at, revision: seen.revision, spent: seen.spent }] : []
}).slice(-SEEN_SPANS)
/** The span a digest id names, `<kind>-<from>-<to>`, for an away digest or a recap. */
const spanOf = (id: string): { from: number; to: number } | undefined => {
  const match = /^(?:away|recap)-(\d{1,16})-(\d{1,16})$/.exec(id)
  const from = Number(match?.[1]), to = Number(match?.[2])
  return match && from <= to ? { from, to } : undefined
}
const within = (at: number | undefined, span: { from: number; to: number }) => at !== undefined && at >= span.from && at <= span.to
const clip = (text: string, max: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat }
const refused = () => Object.assign(new Error('lead-ask-expired'), { wireCode: 'lead-ask-expired' })
const unreadable = () => Object.assign(new Error('The Lead presence file could not be read just now, so nothing was written. Try again in a moment.'), { wireCode: 'unavailable' })

/**
 * Host-side presence: a seen mark per device, the away digest, the morning brief, and what became of each question.
 * One file, `<state>/lead/presence.json`. A digest is built here from the work ledger and the journal alone, so every
 * surface is handed the same one; only the optional paragraph comes from a model, and its cost is counted. Each item
 * names what it opens. A dismissal is the desk's, not the device's: one made on the phone clears the window too.
 */
/** Polite words and fillers that do not make a request new: said with or without them, it is the same request. */
const POLITE = /\b(?:please|pls|plz|kindly|(?:can|could|would) you|just|again|once more|thanks?|thank you)\b|请|麻烦|再|帮我|帮忙|一下|一次|一遍|吧|好吗|谢谢/gu
/** Words that turn a request around. One the earlier request did not carry makes the later one never the request said
 * again; the same words with the same negation are. "停" alone is not one: 停车场 is a car park. */
const NEGATION = /\b(?:don['\u2019]?t|do not|stop|never|cancel|not)\b|别|不要|不用|不必|停下|停掉|停止|取消|算了/gu
const negations = (text: string): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const [word] of text.normalize('NFKC').toLowerCase().replaceAll('\u2019', "'").matchAll(NEGATION)) counts.set(word, (counts.get(word) ?? 0) + 1)
  return counts
}
const CJK_CHAR = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu
/** Words with each Chinese, Japanese or Korean character a word of its own, since those carry no spaces. */
const charWords = (words: readonly string[]): string[] => words.join(' ').replace(CJK_CHAR, ' $1 ').split(/\s+/u).filter(Boolean)
/** Whether the two say the same words with one of them moved ("修停车场的 bug", "停车场的 bug 修"). */
const oneMoved = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length || a.length < 3 || a.join(' ') === b.join(' ')) return false
  return a.some((word, i) => b.some((other, j) => other === word &&
    a.filter((_, index) => index !== i).join(' ') === b.filter((_, index) => index !== j).join(' ')))
}
/** The words of a request, folded for comparison: compatibility forms, case, polite words, punctuation and symbols. */
const requestWords = (text: string): string[] =>
  text.normalize('NFKC').toLowerCase().replace(POLITE, ' ').split(/[\p{P}\p{S}\s]+/u).filter(Boolean)
/** The shorter of two folded requests must hold this much of the longer one's characters for containment to be a repeat. */
const CONTAINED = 0.8

/**
 * Whether `later` only says `earlier` again. Punctuation, symbols, spacing and polite words never make it new, nor
 * does an address or a word more or less around the same request: one contains the other and is at least four fifths
 * of it, they differ by one word, or one word moved. A negation the request did not carry ("don't", "stop", "别…了",
 * "不要") is never a repeat; the same words again, negation and all, are. Anything else is the person moving on.
 */
export const leadRepeatsRequest = (earlier: string, later: string): boolean => {
  const before = negations(earlier)
  for (const [word, count] of negations(later)) if (count > (before.get(word) ?? 0)) return false
  const a = requestWords(earlier), b = requestWords(later)
  const joinedA = a.join(''), joinedB = b.join('')
  if (joinedA === joinedB) return true
  const [short, long] = joinedA.length <= joinedB.length ? [joinedA, joinedB] : [joinedB, joinedA]
  if (short.length >= 4 && long.includes(short) && short.length >= CONTAINED * long.length) return true
  if (oneMoved(charWords(a), charWords(b))) return true
  const [fewer, more] = a.length <= b.length ? [a, b] : [b, a]
  if (more.length - fewer.length !== 1 || fewer.length < 2) return false
  return more.some((_, skip) => more.filter((__, index) => index !== skip).join(' ') === fewer.join(' '))
}

/** Words around a choice that do not change which option it names: "the", "I pick", "选". */
const CHOOSING = /\b(?:the|option|pick|choose|go with|i choose|i pick|i'll take|i will take|let's go with)\b|选择|选|就/gu
/** A text folded to tokens for matching an option: each Chinese, Japanese or Korean character is a token of its own. */
const optionTokens = (text: string): string[] =>
  charWords(requestWords(text.normalize('NFKC').toLowerCase().replaceAll('\u2019', "'").replace(CHOOSING, ' ')))

/**
 * The option a typed answer gives: a tap's exact label, or the whole message folded down to one label with nothing
 * left over but choosing words ("Game.", "the game", "选 game", "I pick game"). Words that only mention an option
 * ("build a game", "fix 2 bugs", "这是什么") answer nothing: short labels turn up in ordinary sentences.
 */
export const leadAskOption = <T extends { readonly label: string }>(options: readonly T[], text: string): T | undefined => {
  const exact = options.find(option => option.label === text)
  if (exact) return exact
  const words = optionTokens(text).join(' ')
  if (!words) return undefined
  const folded = options.filter(option => optionTokens(option.label).join(' ') === words)
  return folded.length === 1 ? folded[0] : undefined
}

/** How long after an answer or an expiry the same words, sent without the question's id, are still taken for a late tap. */
export const LEAD_LATE_TAP_MS = 10 * 60_000
interface ExpiryNote { readonly text: string; readonly after: string | undefined; readonly note: string; messageId?: string }
export class LeadPresenceStore {
  #tail: Promise<unknown> = Promise.resolve()
  #stored: Stored = fresh()
  #loaded = false
  #unreadable = false
  constructor(private readonly ports: LeadPresencePorts) { this.#tail = this.#load().catch(() => {}) }

  async #load(): Promise<void> {
    const read = await readBoundedJsonResult(this.ports.file, MAX_BYTES)
    this.#loaded = false; this.#unreadable = false
    if (read.kind === 'unreadable') { await this.#setAside(); this.#loaded = true; return }
    if (read.kind === 'value') {
      try {
        const value = read.value as Stored
        const brief = parseLeadBriefSettings(value.brief)
        const devices: Record<string, Mark> = {}
        for (const [id, mark] of Object.entries(value.devices ?? {})) {
          if (typeof mark?.seenAt !== 'number' || typeof mark.label !== 'string') continue
          // A digest written by another version of the host keeps what this one can read; one it cannot read is dropped alone.
          const { pending, pendingEnd, ...rest } = mark
          const kept = stored(pending)
          devices[id] = { ...rest, ...(kept ? { pending: kept } : {}), ...(kept && validEnd(pendingEnd) ? { pendingEnd } : {}) }
        }
        const { briefDigest, seen, ...rest } = value
        const briefKept = stored(briefDigest)
        this.#stored = { ...fresh(), ...rest, devices, brief, asks: value.asks && typeof value.asks === 'object' ? value.asks : {},
          ...(briefKept ? { briefDigest: briefKept } : {}), ...(seenSpans(seen).length ? { seen: seenSpans(seen) } : {}) }
      } catch { await this.#setAside(); this.#stored = fresh() }
    } else if (read.kind === 'io') return
    this.#loaded = true
  }
  /** A file whose content cannot be understood is moved beside itself and the record starts empty, as the work ledger does. */
  async #setAside(): Promise<void> {
    this.#stored = fresh()
    try { await rename(this.ports.file, `${this.ports.file}.corrupt-${this.ports.now()}`) } catch { this.#unreadable = true }
  }
  #write<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.#tail.then(async () => {
      // A read that failed just now (not a bad file) is tried again before anything is written over it.
      if (!this.#loaded && !this.#unreadable) await this.#load().catch(() => {})
      if (!this.#loaded || this.#unreadable) throw unreadable()
      if (!this.#stored.origin) this.#stored.origin = { at: this.ports.now(), spent: this.ports.spent() }
      const before = JSON.stringify(this.#stored)
      try {
        const out = await work()
        const after = JSON.stringify(this.#stored)
        if (after !== before) await writeAtomicJson(this.ports.file, this.#stored, async () => {})
        return out
      } catch (error) { this.#stored = JSON.parse(before) as Stored; throw error }
    })
    this.#tail = run.catch(() => {})
    return run
  }

  /** Remember each ask the thread holds: when the host first saw it, and when it stops being answerable. */
  #observeAsks(): void {
    const now = this.ports.now(), messages = this.ports.messages(), live = new Set<string>()
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.ask) continue
      live.add(message.id)
      if (this.#stored.asks[message.id]) continue
      const minutes = message.ask.expiresInMinutes
      this.#stored.asks[message.id] = { seenAt: now, ...(minutes ? { expiresAt: now + minutes * 60_000 } : {}) }
    }
    // The window of messages moves on; keep the newest records that still matter.
    const ids = Object.keys(this.#stored.asks)
    if (ids.length > LEAD_PRESENCE_LIMITS.asks * 2) for (const id of ids.sort((a, b) => this.#stored.asks[a]!.seenAt - this.#stored.asks[b]!.seenAt).slice(0, ids.length - LEAD_PRESENCE_LIMITS.asks)) if (!live.has(id)) delete this.#stored.asks[id]
  }
  #askStates(): LeadAskState[] {
    const now = this.ports.now()
    const out: LeadAskState[] = []
    for (const message of this.ports.messages()) {
      const record = message.role === 'assistant' && message.ask ? this.#stored.asks[message.id] : undefined
      if (!record) continue
      const answered = record.answer !== undefined, expired = !answered && record.expiresAt !== undefined && record.expiresAt <= now
      out.push({ id: message.id, status: answered ? 'answered' : expired ? 'expired' : 'open', ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
        ...(record.answer ? { answer: record.answer } : {}) })
    }
    return out.slice(-LEAD_PRESENCE_LIMITS.asks)
  }

  /** Every item since `since`, in the order the person acts on; the caller drops what was seen, then caps the list. */
  async #items(since: number, revision: number): Promise<LeadDigestItem[]> {
    const board = await this.ports.board().catch(() => null)
    const waiting: LeadDigestItem[] = [], stopped: LeadDigestItem[] = [], done: LeadDigestItem[] = []
    const seen = new Set<string>()
    for (const card of board?.items ?? []) {
      const entry = (kind: LeadDigestItem['kind'], at: number): LeadDigestItem => ({ kind, id: card.id, title: clip(card.title, LEAD_PRESENCE_LIMITS.titleChars) || 'Untitled work',
        ...(card.fact || card.blocker ? { fact: clip(card.fact ?? card.blocker ?? '', LEAD_PRESENCE_LIMITS.factChars) } : {}),
        ref: digestRef(card), at, ...(kind === 'stopped' && card.stoppedBy ? { stoppedBy: card.stoppedBy } : {}) })
      const closed = card.closedAt ?? card.updatedAt
      if (card.stage === 'done' && card.outcome !== 'dropped' && closed >= since) done.push(entry('done', closed))
      else if (card.stage === 'needs-you' && card.updatedAt >= since) { waiting.push(entry('waiting', card.updatedAt)); seen.add(card.id) }
      else if ((card.stage === 'stopped' || card.stage === 'blocked') && card.updatedAt >= since) stopped.push(entry('stopped', card.updatedAt))
    }
    // Decisions that wait on the person but belong to no work item (a plan, a permission change). They open their card.
    for (const card of this.ports.waiting()) if (card.position > revision && !seen.has(card.id))
      waiting.push({ kind: 'waiting', id: card.id, title: clip(card.title, LEAD_PRESENCE_LIMITS.titleChars) || 'A request waits for you', ref: { kind: 'card', id: card.id } })
    return [...waiting, ...stopped, ...done]
  }

  /** The part of a digest that needs only the ledger; the optional paragraph is added outside the queue. */
  async #plan(kind: LeadDigestKind, from: number, baseline: { spent: number; revision: number }): Promise<Plan> {
    const to = Math.max(this.ports.now(), from)
    // An away digest leaves out what the person already dismissed, on any device: what happened inside that span. Its
    // revision and spend count only when the span covers this digest's start; a span later than that start leaves the
    // spend before it to be told. A recap is asked for, so it says everything in its span; the brief keeps its own day.
    const seen = kind === 'away' ? this.#stored.seen ?? [] : []
    const covering = seen.filter(span => span.from <= from && span.at >= from)
    const revision = this.ports.revision(), spentNow = this.ports.spent()
    const found = await this.#items(from, Math.max(baseline.revision, ...covering.map(span => span.revision)))
    // What was dismissed is dropped before the list is capped, so it takes no room and is not counted as more.
    const unseen = found.filter(entry => !seen.some(span => within(entry.at, { from: span.from, to: span.at })))
    const items = unseen.slice(0, LEAD_PRESENCE_LIMITS.items), more = Math.max(0, unseen.length - LEAD_PRESENCE_LIMITS.items)
    return { kind, from, to, items, more, end: { revision, spent: spentNow },
      spent: Math.max(0, spentNow - Math.max(baseline.spent, ...covering.map(span => span.spent))) }
  }
  /** One short paragraph from the smaller model, within the day's cap. Slow and paid, so it never runs inside the queue. */
  async #paragraph(plan: Plan): Promise<{ text: string; usdMicros: number } | null> {
    if (plan.items.length + plan.more < LEAD_PRESENCE_LIMITS.summaryItems || !this.ports.observe) return null
    const day = dayOf(plan.to), used = this.#stored.observer.day === day ? this.#stored.observer.usdMicros : 0
    if (used >= LEAD_DIGEST_OBSERVER_DAILY_MICROS) return null
    const result = await this.ports.observe({ items: plan.items, from: plan.from, to: plan.to }).catch(() => null)
    return result?.text.trim() ? result : null
  }
  #finish(plan: Plan, result: { text: string; usdMicros: number } | null): LeadDigest {
    let spent = plan.spent, summary: string | undefined, summaryUsdMicros: number | undefined
    if (result) {
      const day = dayOf(plan.to), used = this.#stored.observer.day === day ? this.#stored.observer.usdMicros : 0
      summary = clip(result.text, LEAD_PRESENCE_LIMITS.summaryChars)
      summaryUsdMicros = Math.max(0, Math.round(result.usdMicros))
      this.#stored.observer = { day, usdMicros: used + summaryUsdMicros }
      spent += summaryUsdMicros
    }
    return parseLeadDigest({ version: 1, id: `${plan.kind}-${plan.from}-${plan.to}`, kind: plan.kind, from: plan.from, to: plan.to, items: plan.items, more: plan.more,
      spentUsdMicros: spent, ...(summary ? { summary, summaryUsdMicros } : {}) })
  }
  #view(mark: Mark | undefined): LeadPresenceView {
    const brief = this.#stored.briefDigest
    const showBrief = brief && mark && mark.briefDone !== brief.id && this.#stored.briefDone !== brief.id && this.ports.now() - brief.to < BRIEF_LIFE_MS ? brief : null
    // A digest inside the span the person dismissed on any device holds nothing they have not seen.
    const covered = (digest: LeadDigest) => (this.#stored.seen ?? []).some(span => digest.from >= span.from && digest.to <= span.at)
    const pending = mark?.pending && !covered(mark.pending) ? mark.pending : null
    return parseLeadPresenceView({ version: 1, digest: showBrief ?? pending, asks: this.#askStates(), brief: this.#stored.brief })
  }

  /**
   * What this device should see. A device that looks (`active`) after at least thirty minutes away is handed a digest
   * of what changed, once; "What happened?" (`recap`) builds one on demand. Looking also moves the device's seen mark.
   * A digest the person has not dismissed is rebuilt from where it began, so a second absence adds to it rather than
   * being lost behind it.
   */
  async read(device: LeadDeviceRef, options: { readonly active?: boolean; readonly recap?: boolean } = {}): Promise<LeadPresenceView> {
    const step = await this.#write(async () => {
      this.#observeAsks()
      const now = this.ports.now(), revision = this.ports.revision(), spent = this.ports.spent()
      let mark = this.#stored.devices[device.id]
      if (!mark) {
        mark = this.#stored.devices[device.id] = { label: device.label, seenAt: now, revision, spent }
        this.#evict()
        if (!options.recap) return { view: this.#view(mark) }
      }
      mark.label = device.label
      let plan: Plan | undefined
      const pendingBefore = mark.pending?.id
      if (options.recap) {
        const from = Math.min(mark.last?.from ?? now - LEAD_PRESENCE_LIMITS.recapMs, now)
        plan = await this.#plan('recap', from, { spent: mark.last?.spent ?? spent, revision: mark.last?.revision ?? 0 })
        mark.last = { from: now, spent, revision }
      } else if (options.active && now - mark.seenAt >= LEAD_PRESENCE_LIMITS.awayMs) {
        const earlier = mark.pending?.kind === 'away' && mark.last ? mark.last : { from: mark.seenAt, spent: mark.spent, revision: mark.revision }
        plan = await this.#plan('away', earlier.from, earlier)
        plan.baseline = earlier
      }
      // The mark moves at most twice a minute: looking is frequent, and half a minute never changes a half-hour rule.
      // A clock that went backwards moves it back too, rather than leaving it ahead of now for good.
      if (options.active && (now < mark.seenAt || now - mark.seenAt >= 30_000)) { mark.seenAt = now; mark.revision = revision; mark.spent = spent }
      if (plan) plan.replaces = pendingBefore
      return { view: this.#view(mark), plan }
    })
    if (!step.plan) return step.view
    const plan = step.plan, result = await this.#paragraph(plan)
    return this.#write(() => {
      const mark = this.#stored.devices[device.id]
      if (!mark) return step.view
      // The digest read in step one may have been dismissed (or replaced) while the paragraph was fetched: it stays so.
      if (mark.pending?.id !== plan.replaces) return this.#view(mark)
      const digest = this.#finish(plan, result)
      if (plan.kind === 'recap' || digest.items.length || digest.more || digest.spentUsdMicros > 0) {
        mark.pending = digest
        if (plan.end) mark.pendingEnd = plan.end; else delete mark.pendingEnd
        if (plan.baseline) mark.last = plan.baseline
      }
      return this.#view(mark)
    })
  }
  #evict(): void {
    const ids = Object.keys(this.#stored.devices)
    if (ids.length <= LEAD_PRESENCE_LIMITS.devices) return
    for (const id of ids.sort((a, b) => this.#stored.devices[a]!.seenAt - this.#stored.devices[b]!.seenAt).slice(0, ids.length - LEAD_PRESENCE_LIMITS.devices)) delete this.#stored.devices[id]
  }
  /**
   * Dismisses a digest for the desk, not the device: what it showed counts as seen on the window and every phone. The
   * span it covered (from its start to its end, not to the moment of the click) is marked seen with the revision and
   * spend where it ended, so what changed after it was built is still told. Every device's digest loses what falls inside
   * that span and goes when nothing is left; a longer one keeps the rest. An id the desk has since rebuilt (a phone still
   * showing the earlier one) is taken for the span it names, when that span lies inside a digest a device still holds.
   * Dismissing the brief hides the brief only. Any other id changes nothing.
   */
  async dismiss(device: LeadDeviceRef, digest: string): Promise<LeadPresenceView> {
    const step = await this.#write(() => {
      const mark = this.#stored.devices[device.id]
      if (this.#stored.briefDigest?.id === digest) {
        const changed = this.#stored.briefDone !== digest
        this.#stored.briefDone = digest
        return { view: this.#view(mark), changed }
      }
      const devices = Object.values(this.#stored.devices)
      const holder = devices.find(one => one.pending?.id === digest)
      // An id no device holds counts only inside a digest a device still holds: the one the desk rebuilt from it.
      const named = holder ? undefined : spanOf(digest)
      const span = holder?.pending ? { from: holder.pending.from, to: holder.pending.to }
        : named && named.to <= this.ports.now() && devices.some(one => one.pending && one.pending.kind !== 'brief' && one.pending.from <= named.from && named.to <= one.pending.to) ? named : undefined
      if (!span) return { view: this.#view(mark), changed: false }
      const end = holder?.pendingEnd
      const before = JSON.stringify(devices.map(one => [one.pending?.id, one.pending?.items.length]))
      this.#see(span, end)
      for (const one of Object.values(this.#stored.devices)) {
        const pending = one.pending
        if (!pending) continue
        if (pending.id === digest || pending.from >= span.from && pending.to <= span.to) { delete one.pending; delete one.pendingEnd; continue }
        const shown = new Set((holder?.pending?.items ?? []).filter(entry => entry.at === undefined).map(entry => entry.id))
        const items = pending.items.filter(entry => !within(entry.at, span) && !(entry.at === undefined && shown.has(entry.id)))
        if (items.length === pending.items.length) continue
        if (!items.length && !pending.more) { delete one.pending; delete one.pendingEnd; continue }
        one.pending = parseLeadDigest({ ...pending, items })
      }
      const changed = before !== JSON.stringify(devices.map(one => [one.pending?.id, one.pending?.items.length]))
      return { view: this.#view(mark), changed }
    })
    // Every other device re-reads, so a phone drops the digest the window dismissed and the other way round.
    if (step.changed) this.ports.changed?.()
    return step.view
  }
  /** Marks a dismissed span seen, joined with every span it meets; the newest few spans are kept. */
  #see(span: { from: number; to: number }, end: { revision: number; spent: number } | undefined): void {
    let joined: Seen = { from: span.from, at: span.to, revision: end?.revision ?? 0, spent: end?.spent ?? 0 }
    const rest: Seen[] = []
    for (const one of this.#stored.seen ?? []) {
      if (one.from <= joined.at && joined.from <= one.at) joined = { from: Math.min(one.from, joined.from), at: Math.max(one.at, joined.at),
        revision: Math.max(one.revision, joined.revision), spent: Math.max(one.spent, joined.spent) }
      else rest.push(one)
    }
    this.#stored.seen = [...rest, joined].sort((a, b) => a.at - b.at).slice(-SEEN_SPANS)
  }

  /** Every ask the host holds gets its clock the moment it is appended, not when someone first looks. */
  observe(): Promise<void> { return this.#write(() => this.#observeAsks()) }

  /** The newest question that nobody has answered and the person has not talked past, whatever the Lead said after it. */
  #openAsk(): { id: string; ask: LeadAsk } | undefined {
    const messages = this.ports.messages()
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (message.role === 'user' && !message.wake) return undefined
      if (message.role === 'assistant' && message.ask) return { id: message.id, ask: message.ask }
    }
    return undefined
  }
  /**
   * The Lead's newest question while the person has not answered it: not answered, not expired, and nothing the person
   * said since is more than the request it asked about, said again. Work that question decides must not start yet; the
   * person is pointed to it instead. Words that are not a repeat are the person moving on, and free the Lead to act.
   */
  /** When the desk first saw the Lead ask this question; undefined for one it has not seen. */
  askSeenAt(id: string): number | undefined { return this.#stored.asks[id]?.seenAt }
  unansweredAsk(): { readonly id: string; readonly question: string; readonly options: readonly string[] } | null {
    const messages = this.ports.messages(), now = this.ports.now()
    const at = messages.findLastIndex(message => message.role === 'assistant' && message.ask !== undefined)
    if (at < 0) return null
    const message = messages[at]!, record = this.#stored.asks[message.id]
    if (record?.answer || record?.expiresAt !== undefined && record.expiresAt <= now) return null
    // A question with no clock of its own holds work back for a day at most; after that the person has plainly moved on.
    if (record?.expiresAt === undefined && record && now - record.seenAt > LEAD_ASK_HOLD_MS) return null
    // Only the person's own words count: a schedule's, a trigger's or a reminder's message is not them asking or moving on.
    const person = (one: (typeof messages)[number]) => one.role === 'user' && (one.source === undefined || one.source === 'person')
    const asked = messages.slice(0, at).findLast(person)
    const since = messages.slice(at + 1).filter(person)
    if (since.some(one => !asked || !leadRepeatsRequest(asked.text, one.text))) return null
    return { id: message.id, question: message.ask!.question, options: message.ask!.options.map(option => option.label) }
  }
  /** Notes for the model about messages the person sent after a question ran out; each belongs to one message. */
  #notes: ExpiryNote[] = []

  #lastPersonMessage(): { id: string; text: string } | undefined {
    const messages = this.ports.messages()
    for (let index = messages.length - 1; index >= 0; index--) if (messages[index]!.role === 'user' && !messages[index]!.wake) return messages[index]!
    return undefined
  }

  /** The newest question in the thread, answered, expired or talked past. */
  #newestAsk(): { id: string; ask: LeadAsk } | undefined {
    const messages = this.ports.messages()
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (message.role === 'assistant' && message.ask) return { id: message.id, ask: message.ask }
    }
    return undefined
  }

  /**
   * A line for the turn that answers the person's message, when it arrived after a question went stale; read once. The turn for
   * a newer message supersedes an older note, and a scheduled or proactive turn never takes one.
   */
  takeExpiryNote(proactive = false): string | undefined {
    if (proactive) return undefined
    const latest = this.#lastPersonMessage()
    if (!latest) { this.#notes = []; return undefined }
    let found: string | undefined
    this.#notes = this.#notes.filter(entry => {
      const mine = entry.messageId ? entry.messageId === latest.id : latest.id !== entry.after && latest.text === entry.text
      if (mine) { found ??= entry.note; return false }
      // Only a message that has not reached the thread yet may still be waiting for its turn.
      return !entry.messageId && latest.id === entry.after
    })
    return found
  }

  /**
   * Called before the person's text is sent. A text that is the label of an option of the newest open question is an
   * answer to it: an expired question refuses it, so a stale tap does nothing, and the first answer wins, so a second
   * device is refused. A tap names its question; one that names none the thread holds is refused. Other words after an
   * expired question carry a note to the model that nothing was done. Returns a step to run once the send is over.
   */
  async beforeSend(device: LeadDeviceRef | undefined, text: string, askId?: string): Promise<((sent: boolean, messageId?: string) => Promise<void>) | null> {
    // A tap names the question it answers, so a later message in the thread cannot turn it into plain words.
    // A question the person has only repeated their request under is still open: typed words can answer it.
    const held = askId ? undefined : this.unansweredAsk()
    const open = askId ? this.#askById(askId) : this.#openAsk() ?? (held ? this.#askById(held.id) : undefined)
    if (askId && !open) throw refused()
    // Words that are an option of a question nobody can answer any more are not sent as a new request either.
    const stale = !open ? this.#newestAsk() : undefined
    const target = open ?? stale
    if (!target) return null
    // A tap is its option. Typed words are an answer only when they are the option itself, folded, and never when they
    // say again the request the question was asked about: a repeat from another device answers nothing.
    const tapped = askId || !this.#repeatsAskedRequest(target.id, text) ? leadAskOption(target.ask.options, text) : undefined
    if (stale && !tapped) return null
    const by = device?.label ?? 'Desktop'
    return this.#write(() => {
      this.#observeAsks()
      const record = this.#stored.asks[target.id], now = this.ports.now()
      const expired = !record?.answer && record?.expiresAt !== undefined && record.expiresAt <= now
      const option = tapped
      // Untagged words are held to a refusal only while they can still be a late tap: the question is the Lead's last word
      // and its answer or expiry is recent. A tap that names its question is refused whenever it arrives.
      const since = record?.answer?.at ?? (expired ? record!.expiresAt : undefined)
      const lastAssistant = [...this.ports.messages()].reverse().find(message => message.role === 'assistant')
      const fresh = askId !== undefined || (lastAssistant?.id === target.id && since !== undefined && now - since <= LEAD_LATE_TAP_MS)
      if (option && record?.answer) { if (fresh) throw Object.assign(new Error(`Already answered on ${record.answer.by}`), { wireCode: 'lead-ask-answered' }); return null }
      if (stale) { if (expired && option && fresh) throw refused(); return null }
      if (!option || (expired && !fresh)) {
        if (!expired || askId) return null
        const entry: ExpiryNote = { text, after: this.#lastPersonMessage()?.id, note: `The question ${quoteLeadWorkText(target.ask.question, 120)} expired at ${new Date(record!.expiresAt!).toISOString()}; nothing was done. The person's message above is a new request, not an answer to it.` }
        this.#notes = [...this.#notes, entry].slice(-8)
        return async (sent: boolean, messageId?: string) => {
          if (!sent) this.#notes = this.#notes.filter(held => held !== entry)
          else if (messageId) entry.messageId = messageId
        }
      }
      if (expired) throw refused()
      const claim = { option: option.label, by, at: now }
      if (record) record.answer = claim
      // A send that did not go through gives the answer back, so the question stays open for another try.
      return async (sent: boolean) => {
        if (!sent) await this.#write(() => { if (record && this.#stored.asks[target.id]?.answer?.at === claim.at && this.#stored.asks[target.id]?.answer?.by === by) delete this.#stored.asks[target.id]!.answer }).catch(() => {})
        this.ports.changed?.()
      }
    })
  }
  /** Whether `text` says again the person's request the question `id` was asked about. */
  #repeatsAskedRequest(id: string, text: string): boolean {
    const messages = this.ports.messages(), at = messages.findIndex(message => message.id === id)
    const asked = messages.slice(0, Math.max(at, 0)).findLast(one => one.role === 'user' && (one.source === undefined || one.source === 'person'))
    return asked !== undefined && leadRepeatsRequest(asked.text, text)
  }
  #askById(id: string): { id: string; ask: LeadAsk } | undefined {
    const message = this.ports.messages().find(candidate => candidate.id === id)
    return message?.role === 'assistant' && message.ask ? { id: message.id, ask: message.ask } : undefined
  }

  brief(): Promise<LeadBriefSettings> { return this.#tail.then(() => this.#stored.brief) }
  updateBrief(update: LeadBriefUpdate): Promise<LeadBriefSettings> {
    return this.#write(() => {
      this.#stored.brief = { ...this.#stored.brief, ...update }
      // Turning it on, or moving its time, after today's time has passed waits for tomorrow: it never fires the moment it is set.
      const now = this.ports.now(), date = new Date(now), [hour, minute] = this.#stored.brief.at.split(':').map(Number) as [number, number]
      if (this.#stored.brief.enabled && date.getHours() * 60 + date.getMinutes() >= hour * 60 + minute) this.#stored.briefDay = dayOf(now)
      return this.#stored.brief
    })
  }

  /**
   * On the host's minute timer. At the chosen time, once a day, unless quiet hours hold it (it then goes out when they
   * end, the same day). The brief is a digest every device shows at the top of the conversation, plus one push.
   */
  async tick(): Promise<boolean> {
    const step = await this.#write(async () => {
      const { enabled, at } = this.#stored.brief, now = this.ports.now()
      if (!enabled) return null
      const today = dayOf(now), date = new Date(now)
      const [hour, minute] = at.split(':').map(Number) as [number, number]
      if (this.#stored.briefDay === today || date.getHours() * 60 + date.getMinutes() < hour * 60 + minute) return null
      if (await this.ports.quiet()) return null
      if ((await this.ports.briefGate?.() ?? 'act') !== 'act') { this.#stored.briefDay = today; return null }
      const previous = this.#stored.briefDigest, origin = this.#stored.origin ?? { at: now, spent: this.ports.spent() }
      const from = Math.min(previous?.to ?? Math.max(origin.at, now - LEAD_PRESENCE_LIMITS.recapMs), now)
      return { today, plan: await this.#plan('brief', from, { spent: previous ? this.#briefSpent() : origin.spent, revision: previous ? this.#briefRevision() : 0 }) }
    })
    if (!step) return false
    const result = await this.#paragraph(step.plan)
    return this.#write(() => {
      if (this.#stored.briefDay === step.today) return false
      const digest = this.#finish(step.plan, result)
      this.#stored.briefDigest = digest
      this.#stored.briefSpent = this.ports.spent()
      this.#stored.briefRevision = this.ports.revision()
      this.#stored.briefDay = step.today
      const text = leadDigestPushText(digest, this.ports.name())
      this.ports.push?.({ digest: digest.id, phone: capLeadPushText('phone', text), window: capLeadPushText('window', text) })
      this.ports.changed?.()
      return true
    })
  }
  #briefSpent(): number { return this.#stored.briefSpent ?? this.ports.spent() }
  #briefRevision(): number { return this.#stored.briefRevision ?? 0 }
}

/** The decisions that wait on the person, in the host's words, with the revision each appeared at. */
export const leadWaitingDecisions = (state: LeadState): readonly { readonly id: string; readonly title: string; readonly position: number }[] =>
  state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`)).flatMap(card => {
    const title = card.type === 'plan' ? 'A plan waits for your approval'
      : card.type === 'permission-change' ? 'A permission change waits for you'
      : card.type === 'budget-change' ? 'A budget change waits for you'
      : card.type === 'branch-ownership' ? 'A branch waits for your choice'
      : card.type === 'waiting' && card.kind === 'person' ? clip(card.summary, LEAD_PRESENCE_LIMITS.titleChars) || 'A request waits for you'
      : card.type === 'result' && card.outcome === 'reviewed' ? 'A result is ready for your review' : null
    return title ? [{ id: card.id, title, position: state.cardPositions[card.id] ?? state.seq }] : []
  })

/** What rides a turn's work context: the ledger cards, and the host note, which belongs to a person's turn only. */
export const leadTurnContext = (cards: string | null, note: string | undefined, proactive: boolean): string | null =>
  [cards, note && !proactive ? `<host-note>${note}</host-note>` : null].filter(Boolean).join('\n\n') || null
