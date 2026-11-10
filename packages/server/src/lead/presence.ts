import type { LeadState } from '@harnessdesk/lead'
import { LEAD_PRESENCE_LIMITS, capLeadPushText, quoteLeadWorkText, leadDigestPushText, parseLeadBriefSettings, parseLeadDigest, parseLeadPresenceView,
  type LeadAsk, type LeadAskState, type LeadBriefSettings, type LeadBriefUpdate, type LeadDeviceRef, type LeadDigest, type LeadDigestItem,
  type LeadDigestKind, type LeadPresenceView, type LeadWorkBoard } from '@harnessdesk/protocol'
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
  readonly messages: () => readonly { readonly id: string; readonly role: string; readonly text: string; readonly ask?: LeadAsk }[]
  /** Whether quiet hours hold work back right now. */
  readonly quiet: () => Promise<boolean>
  readonly name: () => string
  /** The observer model's paragraph over the changed items, and what it cost. Absent or null: no paragraph. */
  readonly observe?: (input: { readonly items: readonly LeadDigestItem[]; readonly from: number; readonly to: number }) => Promise<{ readonly text: string; readonly usdMicros: number } | null>
  /** One push, already capped for each transport. */
  readonly push?: (notice: { readonly digest: string; readonly phone: { readonly title: string; readonly body: string }; readonly window: { readonly title: string; readonly body: string } }) => void
  /** Presence changed for every device (the brief arrived, or an ask moved). */
  readonly changed?: () => void
}

interface Mark {
  label: string
  seenAt: number
  revision: number
  spent: number
  /** The digest this device has not dismissed. */
  pending?: LeadDigest
  /** Where the latest digest began, for "What happened?" and its spend. */
  last?: { from: number; spent: number; revision: number }
  /** The id of the brief this device dismissed. */
  briefDone?: string
}
interface Plan { replaces?: string; baseline?: { from: number; spent: number; revision: number }; kind: LeadDigestKind; from: number; to: number; items: LeadDigestItem[]; more: number; spent: number }
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
}
const fresh = (): Stored => ({ version: 1, devices: {}, asks: {}, brief: { enabled: false, at: '07:30' }, observer: { day: '', usdMicros: 0 } })
const dayOf = (at: number) => { const date = new Date(at); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
const clip = (text: string, max: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat }
const refused = () => Object.assign(new Error('lead-ask-expired'), { wireCode: 'lead-ask-expired' })
const unreadable = () => Object.assign(new Error('The Lead presence file could not be read just now, so nothing was written. Try again in a moment.'), { wireCode: 'unavailable' })

/**
 * Host-side presence: a seen mark per device, the away digest, the morning brief, and what became of each question.
 * One file, `<state>/lead/presence.json`. A digest is built here from the work ledger and the journal alone, so every
 * surface is handed the same one; only the optional paragraph comes from a model, and its cost is counted.
 */
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
          devices[id] = { ...mark, ...(mark.pending ? { pending: parseLeadDigest(mark.pending) } : {}) }
        }
        this.#stored = { ...fresh(), ...value, devices, brief, asks: value.asks && typeof value.asks === 'object' ? value.asks : {},
          ...(value.briefDigest ? { briefDigest: parseLeadDigest(value.briefDigest) } : {}) }
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

  async #items(since: number, revision: number): Promise<{ items: LeadDigestItem[]; more: number }> {
    const board = await this.ports.board().catch(() => null)
    const waiting: LeadDigestItem[] = [], stopped: LeadDigestItem[] = [], done: LeadDigestItem[] = []
    const seen = new Set<string>()
    for (const card of board?.items ?? []) {
      const entry = (kind: LeadDigestItem['kind']): LeadDigestItem => ({ kind, id: card.id, title: clip(card.title, LEAD_PRESENCE_LIMITS.titleChars) || 'Untitled work',
        ...(card.fact || card.blocker ? { fact: clip(card.fact ?? card.blocker ?? '', LEAD_PRESENCE_LIMITS.factChars) } : {}) })
      if (card.stage === 'done' && card.outcome !== 'dropped' && (card.closedAt ?? card.updatedAt) >= since) done.push(entry('done'))
      else if (card.stage === 'needs-you' && card.updatedAt >= since) { waiting.push(entry('waiting')); seen.add(card.id) }
      else if ((card.stage === 'stopped' || card.stage === 'blocked') && card.updatedAt >= since) stopped.push(entry('stopped'))
    }
    // Decisions that wait on the person but belong to no work item (a plan, a permission change).
    for (const card of this.ports.waiting()) if (card.position > revision && !seen.has(card.id))
      waiting.push({ kind: 'waiting', id: card.id, title: clip(card.title, LEAD_PRESENCE_LIMITS.titleChars) || 'A request waits for you' })
    const all = [...waiting, ...stopped, ...done]
    return { items: all.slice(0, LEAD_PRESENCE_LIMITS.items), more: Math.max(0, all.length - LEAD_PRESENCE_LIMITS.items) }
  }

  /** The part of a digest that needs only the ledger; the optional paragraph is added outside the queue. */
  async #plan(kind: LeadDigestKind, from: number, baseline: { spent: number; revision: number }): Promise<Plan> {
    const to = Math.max(this.ports.now(), from)
    const { items, more } = await this.#items(from, baseline.revision)
    return { kind, from, to, items, more, spent: Math.max(0, this.ports.spent() - baseline.spent) }
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
    const showBrief = brief && mark && mark.briefDone !== brief.id && this.ports.now() - brief.to < BRIEF_LIFE_MS ? brief : null
    return parseLeadPresenceView({ version: 1, digest: showBrief ?? mark?.pending ?? null, asks: this.#askStates(), brief: this.#stored.brief })
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
  /** Dismisses the digest on this device only; every other device keeps its own copy. */
  dismiss(device: LeadDeviceRef, digest: string): Promise<LeadPresenceView> {
    return this.#write(() => {
      const mark = this.#stored.devices[device.id]
      if (mark) {
        if (mark.pending?.id === digest) delete mark.pending
        // Dismissing the brief hides the brief only: an away digest it was covering is still there.
        if (this.#stored.briefDigest?.id === digest) mark.briefDone = digest
      }
      return this.#view(mark)
    })
  }

  /** Every ask the host holds gets its clock the moment it is appended, not when someone first looks. */
  observe(): Promise<void> { return this.#write(() => this.#observeAsks()) }

  /** The newest question that nobody has answered and the person has not talked past, whatever the Lead said after it. */
  #openAsk(): { id: string; ask: LeadAsk } | undefined {
    const messages = this.ports.messages()
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (message.role === 'user') return undefined
      if (message.role === 'assistant' && message.ask) return { id: message.id, ask: message.ask }
    }
    return undefined
  }
  /** Notes for the model about messages the person sent after a question ran out; each belongs to one message. */
  #notes: ExpiryNote[] = []

  #lastPersonMessage(): { id: string; text: string } | undefined {
    const messages = this.ports.messages()
    for (let index = messages.length - 1; index >= 0; index--) if (messages[index]!.role === 'user') return messages[index]!
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
    const open = askId ? this.#askById(askId) : this.#openAsk()
    if (askId && !open) throw refused()
    // Words that are an option of a question nobody can answer any more are not sent as a new request either.
    const stale = !open ? this.#newestAsk() : undefined
    const target = open ?? stale
    if (!target) return null
    const option = target.ask.options.find(candidate => candidate.label === text)
    if (stale && !option) return null
    const by = device?.label ?? 'Desktop'
    return this.#write(() => {
      this.#observeAsks()
      const record = this.#stored.asks[target.id], now = this.ports.now()
      const expired = !record?.answer && record?.expiresAt !== undefined && record.expiresAt <= now
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
