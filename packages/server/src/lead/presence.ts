import type { LeadState } from '@harnessdesk/lead'
import { LEAD_PRESENCE_LIMITS, capLeadPushText, leadDigestPushText, parseLeadBriefSettings, parseLeadDigest, parseLeadPresenceView,
  type LeadAsk, type LeadAskState, type LeadBriefSettings, type LeadBriefUpdate, type LeadDeviceRef, type LeadDigest, type LeadDigestItem,
  type LeadDigestKind, type LeadPresenceView, type LeadWorkBoard } from '@harnessdesk/protocol'
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
export class LeadPresenceStore {
  #tail: Promise<unknown> = Promise.resolve()
  #stored: Stored = fresh()
  #loaded = false
  #unreadable = false
  constructor(private readonly ports: LeadPresencePorts) { this.#tail = this.#load().catch(() => {}) }

  async #load(): Promise<void> {
    const read = await readBoundedJsonResult(this.ports.file, MAX_BYTES)
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
      } catch { this.#unreadable = true }
    } else if (read.kind !== 'missing') this.#unreadable = true
    this.#loaded = true
  }
  #write<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.#tail.then(async () => {
      if (!this.#loaded || this.#unreadable) throw unreadable()
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
      const entry = (kind: LeadDigestItem['kind']): LeadDigestItem => ({ kind, id: card.id, title: clip(card.title, LEAD_PRESENCE_LIMITS.titleChars),
        ...(card.fact || card.blocker ? { fact: clip(card.fact ?? card.blocker ?? '', LEAD_PRESENCE_LIMITS.factChars) } : {}) })
      if (card.stage === 'done' && card.outcome !== 'dropped' && (card.closedAt ?? card.updatedAt) >= since) done.push(entry('done'))
      else if (card.stage === 'needs-you' && card.updatedAt >= since) { waiting.push(entry('waiting')); seen.add(card.id) }
      else if ((card.stage === 'stopped' || card.stage === 'blocked') && card.updatedAt >= since) stopped.push(entry('stopped'))
    }
    // Decisions that wait on the person but belong to no work item (a plan, a permission change).
    for (const card of this.ports.waiting()) if (card.position > revision && !seen.has(card.id))
      waiting.push({ kind: 'waiting', id: card.id, title: clip(card.title, LEAD_PRESENCE_LIMITS.titleChars) })
    const all = [...waiting, ...stopped, ...done]
    return { items: all.slice(0, LEAD_PRESENCE_LIMITS.items), more: Math.max(0, all.length - LEAD_PRESENCE_LIMITS.items) }
  }

  async #digest(kind: LeadDigestKind, from: number, baseline: { spent: number; revision: number }): Promise<LeadDigest> {
    const to = this.ports.now()
    const { items, more } = await this.#items(from, baseline.revision)
    let spent = Math.max(0, this.ports.spent() - baseline.spent), summary: string | undefined, summaryUsdMicros: number | undefined
    if (items.length + more >= LEAD_PRESENCE_LIMITS.summaryItems && this.ports.observe) {
      const day = dayOf(to), used = this.#stored.observer.day === day ? this.#stored.observer.usdMicros : 0
      if (used < LEAD_DIGEST_OBSERVER_DAILY_MICROS) {
        const result = await this.ports.observe({ items, from, to }).catch(() => null)
        if (result?.text.trim()) {
          summary = clip(result.text, LEAD_PRESENCE_LIMITS.summaryChars)
          summaryUsdMicros = Math.max(0, Math.round(result.usdMicros))
          this.#stored.observer = { day, usdMicros: used + summaryUsdMicros }
          spent += summaryUsdMicros
        }
      }
    }
    return parseLeadDigest({ version: 1, id: `${kind}-${from}-${to}`, kind, from, to, items, more, spentUsdMicros: spent,
      ...(summary ? { summary, summaryUsdMicros } : {}) })
  }
  #view(mark: Mark | undefined): LeadPresenceView {
    const brief = this.#stored.briefDigest
    const showBrief = brief && mark && mark.briefDone !== brief.id && this.ports.now() - brief.to < BRIEF_LIFE_MS ? brief : null
    return parseLeadPresenceView({ version: 1, digest: showBrief ?? mark?.pending ?? null, asks: this.#askStates(), brief: this.#stored.brief })
  }

  /**
   * What this device should see. A device that looks (`active`) after at least thirty minutes away is handed a digest
   * of what changed, once; "What happened?" (`recap`) builds one on demand. Looking also moves the device's seen mark.
   */
  read(device: LeadDeviceRef, options: { readonly active?: boolean; readonly recap?: boolean } = {}): Promise<LeadPresenceView> {
    return this.#write(async () => {
      this.#observeAsks()
      const now = this.ports.now(), revision = this.ports.revision(), spent = this.ports.spent()
      let mark = this.#stored.devices[device.id]
      if (!mark) {
        mark = this.#stored.devices[device.id] = { label: device.label, seenAt: now, revision, spent }
        this.#evict()
        if (!options.recap) return this.#view(mark)
      }
      mark.label = device.label
      if (options.recap) {
        const from = mark.last?.from ?? now - LEAD_PRESENCE_LIMITS.recapMs
        mark.pending = await this.#digest('recap', from, { spent: mark.last?.spent ?? spent, revision: mark.last?.revision ?? 0 })
        mark.last = { from: now, spent, revision }
      } else if (options.active && !mark.pending && now - mark.seenAt >= LEAD_PRESENCE_LIMITS.awayMs) {
        const digest = await this.#digest('away', mark.seenAt, { spent: mark.spent, revision: mark.revision })
        if (digest.items.length || digest.more || digest.spentUsdMicros > 0) { mark.pending = digest; mark.last = { from: mark.seenAt, spent: mark.spent, revision: mark.revision } }
      }
      // The mark moves at most twice a minute: looking is frequent, and half a minute never changes a half-hour rule.
      if (options.active && now - mark.seenAt >= 30_000) { mark.seenAt = now; mark.revision = revision; mark.spent = spent }
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
        // The brief covers the same hours an away digest would, so dismissing it settles both.
        if (this.#stored.briefDigest?.id === digest) { mark.briefDone = digest; delete mark.pending }
      }
      return this.#view(mark)
    })
  }

  /**
   * Called before the person's text is sent. A text that is the label of an option of the question just asked is an
   * answer to it: an expired question refuses it, so a stale tap does nothing. Returns the record step to run once sent.
   */
  async beforeSend(device: LeadDeviceRef | undefined, text: string): Promise<(() => Promise<void>) | null> {
    const last = this.ports.messages().at(-1)
    const ask = last?.role === 'assistant' ? last.ask : undefined
    const option = ask?.options.find(candidate => candidate.label === text)
    if (!last || !ask || !option) return null
    await this.#write(() => this.#observeAsks())
    const state = this.#askStates().find(entry => entry.id === last.id)
    if (state?.status === 'expired') throw refused()
    if (state?.status === 'answered') return null
    return () => this.#write(() => {
      const record = this.#stored.asks[last.id]
      if (record && !record.answer) record.answer = { option: option.label, by: device?.label ?? 'Desktop', at: this.ports.now() }
    }).then(() => this.ports.changed?.())
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
  tick(): Promise<boolean> {
    return this.#write(async () => {
      const { enabled, at } = this.#stored.brief, now = this.ports.now()
      if (!enabled) return false
      const today = dayOf(now), date = new Date(now)
      const [hour, minute] = at.split(':').map(Number) as [number, number]
      if (this.#stored.briefDay === today || date.getHours() * 60 + date.getMinutes() < hour * 60 + minute) return false
      if (await this.ports.quiet()) return false
      const from = this.#stored.briefDigest?.to ?? now - LEAD_PRESENCE_LIMITS.recapMs
      const digest = await this.#digest('brief', from, { spent: this.#stored.briefDigest ? this.#briefSpent() : this.ports.spent(), revision: this.#stored.briefDigest ? this.#briefRevision() : this.ports.revision() })
      this.#stored.briefDigest = digest
      this.#stored.briefSpent = this.ports.spent()
      this.#stored.briefRevision = this.ports.revision()
      this.#stored.briefDay = today
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
      : card.type === 'waiting' && card.kind === 'person' ? clip(card.summary, LEAD_PRESENCE_LIMITS.titleChars)
      : card.type === 'result' && card.outcome === 'reviewed' ? 'A result is ready for your review' : null
    return title ? [{ id: card.id, title, position: state.cardPositions[card.id] ?? state.seq }] : []
  })
