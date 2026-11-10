import { isWaitingOnYou, LEAD_WORK_GROUPS, LEAD_WORK_LIMITS, leadWorkGroup, type LeadStage, type LeadWorkBoard, type LeadWorkCard,
  type LeadWorkClose, type LeadWorkDetail, type LeadWorkFact, type LeadWorkLinks, type LeadWorkNote, type LeadWorkOrigin, type LeadWorkStage } from '@harnessdesk/protocol'
import { readBoundedJson, writeAtomicJson } from './bounded-json.js'

/** A link's stage in the phone's waiting-on-whom words, with the host's reason for it. */
export interface LeadWorkLinkState { readonly stage: LeadStage; readonly reason: string }
export interface LeadWorkPorts {
  readonly file: string
  readonly now: () => number
  /** The selected project's display name, for new items. */
  readonly project: () => string | null
  /** A chat's host stage; null when the desk no longer holds it. */
  readonly chat: (id: string) => LeadWorkLinkState | null
  /** Every Team the desk knows, by id; `done` once its result was accepted and it wrapped. */
  readonly teams: () => Promise<ReadonlyMap<string, LeadWorkLinkState & { readonly done: boolean }>>
  /** Pull requests the Lead follows right now, as `owner/repo#number`. */
  readonly pullRequests: () => readonly { readonly ref: string; readonly state: 'open' | 'merged' | 'closed'; readonly failing: boolean }[]
  /** A mark that grows whenever the Lead replies to the person. */
  readonly replies: () => number
  readonly publish?: (board: LeadWorkBoard) => void
}
export interface LeadWorkClaim { readonly token: number; readonly item: string | null; readonly title: string; readonly quotes: readonly string[] }
/** What an accepted mention, trigger or approved plan brings to `attach`. */
export interface LeadWorkAttachOrigin { readonly kind: LeadWorkOrigin['kind']; readonly ref?: string; readonly title: string; readonly quotes?: readonly string[] }
export interface LeadWorkReminder { readonly id: string; readonly remindAt: number; readonly text: string }

/** The doors a due reminder can wake the Lead through; both already exist for scheduled runs. */
export interface LeadWorkWake {
  /** Quiet hours, read from the same schedule the repeats use. */
  readonly quiet: () => Promise<boolean>
  /** Whether a new goal may begin: the thread has closed, so a reminder opens one like a scheduled run would. */
  readonly canBegin: () => boolean
  /** The automatic-goal door a scheduled run uses. True once the Lead has it. */
  readonly offer: (key: string, text: string, id: string) => Promise<boolean>
  /** A schedule-sourced turn in the open conversation. True once the Lead has it. */
  readonly remind: (key: string, text: string) => Promise<boolean>
}

/**
 * Wakes the Lead for each reminder that has come due, on the host's existing minute tick. A reminder is cleared only
 * after the Lead has it; one that cannot be delivered now (quiet hours, a turn in flight, a stopped allowance) stays
 * set and is tried again on the next tick. The key is stable per reminder, so a retry after a crash is not a second wake.
 */
export const wakeForLeadWork = async (ledger: Pick<LeadWorkLedger, 'dueReminders' | 'reminded'>, wake: LeadWorkWake): Promise<number> => {
  let woke = 0
  for (const due of await ledger.dueReminders()) {
    if (await wake.quiet()) return woke
    const key = `work-reminder-${due.id}-${due.remindAt}`
    const delivered = wake.canBegin() ? await wake.offer(key, due.text, due.id) : await wake.remind(key, due.text)
    if (!delivered) return woke
    await ledger.reminded(due.id, due.remindAt)
    woke++
  }
  return woke
}

interface Watch {
  /** A chat or Team seen doing something since it was linked. */
  active?: boolean
  /** The Lead's reply mark when the chat was seen finished. */
  mark?: number
  /** Last pull request state seen. */
  pr?: 'open' | 'merged' | 'closed'
  failing?: boolean
  last?: string
}
interface Item {
  id: string; title: string; project: string | null; origin: LeadWorkOrigin
  links: { chats: string[]; teams: string[]; prs: string[]; issues: string[] }
  stage: LeadWorkStage; blocker?: string; note?: string; after?: string; remindAt?: number
  createdAt: number; updatedAt: number; closedAt?: number; outcome?: 'done' | 'dropped'; closedBy?: 'person' | 'host'
  timeline: LeadWorkFact[]; watch: Record<string, Watch>
}
interface Stored { version: 1; next: number; items: Item[] }

const MAX_BYTES = 2 * 1024 * 1024
const missing = (id: string) => Object.assign(new Error(`There is no work item ${id}.`), { wireCode: 'notFound' })
const clip = (text: string, max: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat }
const words = (title: string) => title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const similar = (a: string, b: string): boolean => {
  const left = words(a), right = words(b)
  if (!left || !right) return false
  if (left === right) return true
  const x = new Set(left.split(' ')), y = new Set(right.split(' '))
  if (x.size < 3 || y.size < 3) return false
  // A differing number names different work (issue 41 and issue 42), however alike the rest of the words are.
  if ([...x].some(word => !y.has(word) && /\p{N}/u.test(word)) || [...y].some(word => !x.has(word) && /\p{N}/u.test(word))) return false
  const shared = [...x].filter(word => y.has(word)).length
  return shared / (x.size + y.size - shared) >= 0.8
}
const REASONS: Readonly<Record<string, string>> = {
  'worker-approval': 'An approval waits for you', failed: 'A chat failed', 'queue-paused': 'A queued message is paused',
  'needs-you': 'A Team needs a choice', 'result-ready': 'A result is ready for your review', stopped: 'A Team stopped',
}
const kinds = ['chats', 'teams', 'prs', 'issues'] as const
const emptyLinks = () => ({ chats: [] as string[], teams: [] as string[], prs: [] as string[], issues: [] as string[] })
const isItem = (value: unknown): value is Item => {
  const item = value as Item
  return !!item && typeof item === 'object' && typeof item.id === 'string' && /^work-[1-9][0-9]{0,8}$/.test(item.id) &&
    typeof item.title === 'string' && typeof item.createdAt === 'number' && typeof item.updatedAt === 'number' &&
    !!item.links && kinds.every(kind => Array.isArray(item.links[kind]) && item.links[kind].every(link => typeof link === 'string')) &&
    !!item.origin && Array.isArray(item.origin.quotes) && Array.isArray(item.timeline) && !!item.watch && typeof item.watch === 'object'
}

/**
 * The host's work ledger, `<state>/lead/work.json`. Items are made by the host, never by the model: a start the Lead
 * makes for a person message, an approved plan, or accepted work that `attach` brings. Stages are recomputed from the
 * desk on every `refresh`; the model writes only notes, `after` and reminders. One board projection serves the
 * window, the phone and the Lead's own request.
 */
export class LeadWorkLedger {
  #tail: Promise<unknown> = Promise.resolve()
  #pending = new Map<number, LeadWorkClaim>()
  #token = 0
  #published = ''
  #refreshing: Promise<void> | null = null
  #again = false
  private stored: Stored = { version: 1, next: 1, items: [] }
  /** Reads the file in the background; every call waits for it. An unreadable file starts an empty ledger. */
  constructor(private readonly ports: LeadWorkPorts) {
    this.#tail = (async () => {
      const value = await readBoundedJson(ports.file, MAX_BYTES) as Partial<Stored> | undefined
      const items = value?.version === 1 && Array.isArray(value.items) ? value.items.filter(isItem).slice(-LEAD_WORK_LIMITS.items) : []
      const next = Math.max(typeof value?.next === 'number' && Number.isSafeInteger(value.next) ? value.next : 1,
        ...items.map(item => Number(item.id.slice(5)) + 1))
      this.stored = { version: 1, next, items }
      this.#published = JSON.stringify(this.#board('open'))
    })().catch(() => {})
  }
  static async open(ports: LeadWorkPorts): Promise<LeadWorkLedger> {
    const ledger = new LeadWorkLedger(ports)
    await ledger.#tail
    return ledger
  }

  #open(id: string): Item | undefined { return this.stored.items.find(item => item.id === id && item.closedAt === undefined) }
  #fact(item: Item, text: string): void {
    item.timeline.push({ at: this.ports.now(), text: clip(text, LEAD_WORK_LIMITS.factChars) })
    if (item.timeline.length > LEAD_WORK_LIMITS.timeline) item.timeline.splice(0, item.timeline.length - LEAD_WORK_LIMITS.timeline)
    item.updatedAt = this.ports.now()
  }
  #duplicate(title: string, quotes: readonly string[], except?: string): string | null {
    const covers = (other: { title: string; quotes: readonly string[] }) =>
      quotes.some(quote => other.quotes.includes(quote)) || similar(title, other.title)
    for (const claim of this.#pending.values())
      if (claim.item === null && covers(claim)) return `A start for this request is already starting ("${clip(claim.title, 60)}"). Wait for its result instead of starting another chat.`
    const open = this.stored.items.find(item => item.closedAt === undefined && item.id !== except && covers({ title: item.title, quotes: item.origin.quotes }))
    return open ? `Open work ${open.id} "${clip(open.title, 80)}" (${open.stage}) already covers this request. Pass ledgerItem "${open.id}" to add a chat to it, or use chat_send to continue its chat.` : null
  }

  /**
   * The duplicate guard for `chat_start`. With `ledgerItem` the start joins that open item; after a move it joins the
   * moved chat's item; otherwise an open item with the same origin message or a matching title refuses it, naming the
   * item. A claim holds until `started` or `release`, so two identical starts in flight cannot both land.
   */
  async claim(input: { readonly title: string; readonly quotes: readonly string[]; readonly ledgerItem?: string; readonly moveFrom?: string }): Promise<LeadWorkClaim | { readonly problem: string }> {
    await this.#tail
    const title = clip(input.title.split(/\r?\n/).find(line => line.trim()) ?? input.title, LEAD_WORK_LIMITS.titleChars) || 'Untitled work'
    let item: string | null = null
    if (input.ledgerItem !== undefined) {
      const found = this.stored.items.find(entry => entry.id === input.ledgerItem)
      if (!found) return { problem: `There is no work item ${input.ledgerItem}. Read work_list for the open items, or start without ledgerItem for new work.` }
      if (found.closedAt !== undefined) return { problem: `Work ${found.id} is closed. Start without ledgerItem for new work.` }
      item = found.id
    } else if (input.moveFrom !== undefined) {
      item = this.stored.items.find(entry => entry.closedAt === undefined && entry.links.chats.includes(input.moveFrom!))?.id ?? null
    }
    if (item === null) {
      const problem = this.#duplicate(title, input.quotes)
      if (problem) return { problem }
      if (this.stored.items.filter(entry => entry.closedAt === undefined).length >= LEAD_WORK_LIMITS.items)
        return { problem: 'The work ledger is full of open items. Ask the person to close finished work first.' }
    }
    const claim = { token: ++this.#token, item, title, quotes: [...input.quotes] }
    this.#pending.set(claim.token, claim)
    return claim
  }
  release(claim: LeadWorkClaim): void { this.#pending.delete(claim.token) }

  /** The claimed start made a chat: link it to its item, making the item first when the claim was for new work. */
  started(claim: LeadWorkClaim, chat: string): Promise<string> {
    return this.#write(() => {
      this.#pending.delete(claim.token)
      const item = claim.item === null ? this.#create({ kind: 'person', quotes: claim.quotes }, claim.title) : this.stored.items.find(entry => entry.id === claim.item)!
      this.#link(item, 'chats', chat)
      this.#fact(item, 'A chat started')
      return item.id
    })
  }

  /**
   * For area 5 and the host's own triggers: creates or attaches an item for work accepted another way (a mention triage
   * accepted, an approved plan). An open item with the same origin, or already holding any of these links, absorbs
   * the rest; otherwise a new item is made. Returns the item's id.
   */
  attach(origin: LeadWorkAttachOrigin, links: Partial<LeadWorkLinks>): Promise<string> {
    return this.#write(() => {
      const wanted = kinds.flatMap(kind => (links[kind] ?? []).map(link => [kind, link] as const))
      let item = this.stored.items.find(entry => entry.closedAt === undefined && (
        origin.ref !== undefined && entry.origin.kind === origin.kind && entry.origin.ref === origin.ref ||
        wanted.some(([kind, link]) => entry.links[kind].includes(link))))
      if (!item) {
        if (this.stored.items.filter(entry => entry.closedAt === undefined).length >= LEAD_WORK_LIMITS.items) throw new Error('The work ledger is full of open items.')
        item = this.#create({ kind: origin.kind, ...(origin.ref ? { ref: clip(origin.ref, 300) } : {}), quotes: [...(origin.quotes ?? [])].slice(0, 3) },
          clip(origin.title, LEAD_WORK_LIMITS.titleChars) || 'Untitled work')
      }
      for (const [kind, link] of wanted) if (!item.links[kind].includes(link)) { this.#link(item, kind, link); this.#fact(item, `Linked ${kind === 'prs' ? 'pull request' : kind.slice(0, -1)} ${link}`) }
      return item.id
    })
  }

  #create(origin: LeadWorkOrigin, title: string): Item {
    const now = this.ports.now()
    const item: Item = { id: `work-${this.stored.next++}`, title, project: this.ports.project(), origin, links: emptyLinks(), stage: 'queued',
      createdAt: now, updatedAt: now, timeline: [], watch: {} }
    this.stored.items.push(item)
    this.#fact(item, origin.kind === 'person' ? 'The person asked for it' : `Came from a ${origin.kind}`)
    return item
  }
  #link(item: Item, kind: typeof kinds[number], link: string): void {
    if (item.links[kind].includes(link)) return
    item.links[kind].push(link)
    if (item.links[kind].length > LEAD_WORK_LIMITS.linksPerKind) item.links[kind].shift()
  }

  /** The model's only write. A note, what the item waits for, and a reminder at most thirty days ahead. */
  note(input: LeadWorkNote): Promise<LeadWorkCard> {
    return this.#write(() => {
      const item = this.stored.items.find(entry => entry.id === input.id)
      if (!item) throw missing(input.id)
      if (input.after !== undefined && input.after !== null) {
        if (input.after === item.id) throw new Error('An item cannot wait for itself.')
        if (!this.stored.items.some(entry => entry.id === input.after)) throw missing(input.after)
        for (let next: string | undefined = input.after, hops = 0; next && hops < LEAD_WORK_LIMITS.items; hops++) {
          if (next === item.id) throw new Error('That would make the items wait for each other.')
          next = this.stored.items.find(entry => entry.id === next)?.after
        }
      }
      if (input.note !== undefined) {
        const note = clip(input.note, LEAD_WORK_LIMITS.noteChars)
        if (note) item.note = note; else delete item.note
        this.#fact(item, note ? 'The Lead wrote a note' : 'The Lead cleared its note')
      }
      if (input.after !== undefined) { if (input.after === null) delete item.after; else item.after = input.after }
      if (input.remindAt !== undefined) {
        if (input.remindAt === null) delete item.remindAt
        else item.remindAt = Math.min(Math.max(input.remindAt, this.ports.now()), this.ports.now() + LEAD_WORK_LIMITS.remindMs)
        this.#fact(item, input.remindAt === null ? 'Reminder cleared' : 'Reminder set')
      }
      item.updatedAt = this.ports.now()
      return this.#card(item)
    })
  }

  /** The person's Done or Drop. Desk activity never reopens what the person closed. */
  close(input: LeadWorkClose): Promise<LeadWorkBoard> {
    return this.#write(() => {
      const item = this.stored.items.find(entry => entry.id === input.id)
      if (!item) throw missing(input.id)
      if (item.closedAt === undefined || item.closedBy !== 'person') {
        item.closedAt = this.ports.now(); item.closedBy = 'person'; item.outcome = input.outcome
        item.stage = input.outcome === 'done' ? 'done' : 'stopped'; delete item.blocker; delete item.remindAt
        this.#fact(item, input.outcome === 'done' ? 'The person marked it done' : 'The person dropped it')
      }
      return this.#board('open')
    })
  }

  /** Reminders whose time came, for the host's minute timer to deliver. */
  async dueReminders(): Promise<readonly LeadWorkReminder[]> {
    await this.#tail
    const now = this.ports.now()
    return this.stored.items.filter(item => item.closedAt === undefined && item.remindAt !== undefined && item.remindAt <= now).map(item => ({
      id: item.id, remindAt: item.remindAt!,
      text: `Reminder you set for work ${item.id} "${clip(item.title, 80)}" (now ${item.stage}${item.blocker ? `: ${item.blocker}` : ''}).${item.note ? ` Your note: ${item.note}` : ''} Check on it and tell the person only what they need to know.`,
    }))
  }
  reminded(id: string, remindAt: number): Promise<void> {
    return this.#write(() => {
      const item = this.stored.items.find(entry => entry.id === id)
      if (!item || item.remindAt !== remindAt) return
      delete item.remindAt
      this.#fact(item, 'The reminder woke the Lead')
    })
  }

  async board(state: 'open' | 'all' = 'open'): Promise<LeadWorkBoard> { await this.#tail; return this.#board(state) }
  async read(input: { readonly id: string }): Promise<LeadWorkDetail> {
    await this.#tail
    const item = this.stored.items.find(entry => entry.id === input.id)
    if (!item) throw missing(input.id)
    return { ...this.#card(item), origin: { ...item.origin, quotes: [...item.origin.quotes] }, timeline: item.timeline.map(fact => ({ ...fact })) }
  }

  /** Recompute every open item from the desk. Coalesced: a refresh asked for while one runs runs once more after it. */
  refresh(): Promise<void> {
    if (this.#refreshing) { this.#again = true; return this.#refreshing }
    const run = (async () => {
      do {
        this.#again = false
        let teams: ReadonlyMap<string, LeadWorkLinkState & { readonly done: boolean }>
        try { teams = await this.ports.teams() } catch { teams = new Map() }
        const prs = new Map(this.ports.pullRequests().map(pr => [pr.ref, pr]))
        await this.#write(() => {
          const now = this.ports.now()
          this.stored.items = this.stored.items.filter(item => item.closedAt === undefined || now - item.closedAt < LEAD_WORK_LIMITS.closedMs)
          for (const item of this.stored.items) this.#derive(item, teams, prs)
        })
      } while (this.#again)
    })()
    this.#refreshing = run.finally(() => { this.#refreshing = null })
    return this.#refreshing
  }

  #derive(item: Item, teams: ReadonlyMap<string, LeadWorkLinkState & { readonly done: boolean }>, prs: ReadonlyMap<string, { readonly state: 'open' | 'merged' | 'closed'; readonly failing: boolean }>): void {
    if (item.closedBy === 'person') return
    const states: { stage: LeadStage; reason: string; settled: boolean; review?: string }[] = []
    const replies = this.ports.replies()
    for (const chat of item.links.chats) {
      const watch = item.watch[`chat:${chat}`] ??= {}
      const live = this.ports.chat(chat)
      if (live === null) { if (watch.last !== 'gone') { watch.last = 'gone'; this.#fact(item, 'A chat left the desk') } states.push({ stage: 'idle', reason: 'gone', settled: true }); continue }
      if (live.stage === 'idle') {
        if (watch.mark === undefined) { watch.mark = replies; this.#fact(item, 'A chat finished') }
        const reported = replies > watch.mark
        states.push({ stage: 'idle', reason: 'idle', settled: reported, ...(reported ? {} : { review: 'Finished; the Lead is checking it' }) })
      } else {
        if (watch.last !== live.reason) {
          if (live.stage === 'working') this.#fact(item, 'A chat is working')
          else if (isWaitingOnYou(live.stage)) this.#fact(item, REASONS[live.reason] ?? 'A chat waits for you')
        }
        delete watch.mark; watch.active = true
        states.push({ stage: live.stage, reason: live.reason, settled: false })
      }
      watch.last = live.stage === 'idle' ? 'idle' : live.reason
    }
    for (const team of item.links.teams) {
      const watch = item.watch[`team:${team}`] ??= {}
      const live = teams.get(team)
      if (!live) { states.push({ stage: 'idle', reason: 'gone', settled: teams.size > 0 || watch.last === 'done' }); continue }
      if (live.done) { if (watch.last !== 'done') this.#fact(item, 'A Team finished and wrapped'); watch.last = 'done'; states.push({ stage: 'idle', reason: 'done', settled: true }); continue }
      if (watch.last !== live.reason && isWaitingOnYou(live.stage)) this.#fact(item, REASONS[live.reason] ?? 'A Team waits for you')
      watch.last = live.reason
      states.push({ stage: live.stage, reason: live.reason, settled: false, ...(live.stage === 'idle' ? { review: 'The Team is idle' } : {}) })
    }
    for (const ref of item.links.prs) {
      const watch = item.watch[`pr:${ref}`] ??= {}
      const seen = prs.get(ref)
      if (seen && (seen.state !== watch.pr || seen.failing !== watch.failing)) {
        this.#fact(item, seen.state === 'merged' ? `Pull request ${ref} merged` : seen.state === 'closed' ? `Pull request ${ref} closed without merging`
          : seen.failing ? `Checks are failing on ${ref}` : `Pull request ${ref} is open`)
        watch.pr = seen.state; watch.failing = seen.failing
      }
      const state = watch.pr ?? 'open'
      states.push(state === 'open' ? { stage: 'idle', reason: 'pull-request', settled: false, review: watch.failing ? `Checks are failing on ${ref}` : `Pull request ${ref} is open` }
        : { stage: 'idle', reason: state, settled: true })
    }
    // Activity reopens what the host itself closed: the Lead sent the chat more work.
    if (item.closedAt !== undefined) {
      if (!states.some(state => state.stage !== 'idle')) return
      delete item.closedAt; delete item.outcome; delete item.closedBy
      this.#fact(item, 'Work started again')
    }
    const waiting = states.find(state => isWaitingOnYou(state.stage))
    const after = item.after ? this.#open(item.after) : undefined
    let stage: LeadWorkStage, blocker: string | undefined
    if (waiting) { stage = 'needs-you'; blocker = REASONS[waiting.reason] ?? 'Waits for you' }
    else if (after) { stage = 'blocked'; blocker = `Waits for ${after.id} "${clip(after.title, 60)}"` }
    else if (states.some(state => state.stage === 'working')) stage = 'working'
    else if (states.some(state => state.stage === 'queued')) stage = 'queued'
    else if (states.length && states.every(state => state.settled)) {
      stage = 'done'; item.closedAt = this.ports.now(); item.closedBy = 'host'; item.outcome = 'done'; delete item.remindAt
      this.#fact(item, 'Every link settled')
    }
    else if (states.some(state => state.review !== undefined)) { stage = 'in-review'; blocker = states.find(state => state.review?.startsWith('Checks'))?.review }
    else stage = 'queued'
    if (stage !== item.stage || blocker !== item.blocker) item.updatedAt = this.ports.now()
    item.stage = stage
    if (blocker) item.blocker = blocker; else delete item.blocker
  }

  #card(item: Item): LeadWorkCard {
    const fact = item.timeline.at(-1)?.text
    return {
      id: item.id, title: item.title, project: item.project, stage: item.stage, group: leadWorkGroup(item.stage),
      ...(item.blocker ? { blocker: item.blocker } : {}), ...(fact ? { fact } : {}), ...(item.note ? { note: item.note } : {}),
      ...(item.after ? { after: item.after } : {}), ...(item.remindAt !== undefined ? { remindAt: item.remindAt } : {}),
      links: { chats: [...item.links.chats], teams: [...item.links.teams], prs: [...item.links.prs], issues: [...item.links.issues] },
      createdAt: item.createdAt, updatedAt: item.updatedAt,
      ...(item.closedAt !== undefined ? { closedAt: item.closedAt } : {}), ...(item.outcome ? { outcome: item.outcome } : {}),
    }
  }
  #board(state: 'open' | 'all'): LeadWorkBoard {
    const now = this.ports.now()
    const order = (a: Item, b: Item) => LEAD_WORK_GROUPS.indexOf(leadWorkGroup(a.stage)) - LEAD_WORK_GROUPS.indexOf(leadWorkGroup(b.stage)) ||
      (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt) || Number(b.id.slice(5)) - Number(a.id.slice(5))
    const open = this.stored.items.filter(item => item.closedAt === undefined)
    const closed = this.stored.items.filter(item => item.closedAt !== undefined).sort(order)
    const shown = state === 'all' ? closed : closed.filter(item => now - item.closedAt! < LEAD_WORK_LIMITS.doneMs).slice(0, LEAD_WORK_LIMITS.doneShown)
    return { version: 1, items: [...open, ...shown].sort(order).map(item => this.#card(item)), more: closed.length - shown.length }
  }

  #write<T>(change: () => T): Promise<T> {
    const run = this.#tail.then(async () => {
      const before = JSON.stringify(this.stored)
      const result = change()
      if (JSON.stringify(this.stored) !== before) await writeAtomicJson(this.ports.file, this.stored, async () => {})
      const board = this.#board('open'), text = JSON.stringify(board)
      if (text !== this.#published) { this.#published = text; try { this.ports.publish?.(board) } catch { /* A window that cannot take it reads again. */ } }
      return result
    })
    this.#tail = run.catch(() => {})
    return run
  }
}
