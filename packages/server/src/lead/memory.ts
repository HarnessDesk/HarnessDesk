import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { leadMemoryBytes, type LeadMemoryCore, type LeadMemoryProposalState, type LeadMemoryProposalStatus, type LeadMemoryStatus } from '@harnessdesk/lead'
import { LEAD_MEMORY_LIMITS, LEAD_SCHEDULE_LIMITS, parseLeadMemoryCandidate, parseLeadMemoryEntry, type LeadMemory, type LeadMemoryCandidate, type LeadMemoryChange,
  type LeadMemoryChangeBy, type LeadMemoryEntry, type LeadMemoryKind, type LeadMemoryProposal, type LeadMemoryProposalResult, type LeadMemoryVersionSummary,
  type LeadMemoryView } from '@harnessdesk/protocol'
import { readBoundedJsonResult, writeAtomicJson } from './bounded-json.js'
import { leadRefusal } from './controls.js'
import { leadMemoryFold, leadMemoryHasSecret, leadMemoryKey, leadMemoryNear, leadMemoryScan, leadMemoryTokens } from './memory-scan.js'

/**
 * The Lead's memory, kept by the host in `<home>/lead/memory-store.json`. Entries sit in Core (always in the Lead's
 * standing instructions, at most `coreBytes` as the Lead reads them) or Archive (searched on demand). The Lead only
 * proposes: a proposal is scanned, then waits in the person's inbox. Every change to the entries leaves a version that
 * Undo can put back exactly, until a later change touches the same entries. The person's entries are changed only by
 * the person.
 */
const FILE = 'memory-store.json'
const FILE_BYTES = 4_000_000

interface StoredChange { readonly id: string; readonly before: LeadMemoryEntry | null; readonly after: LeadMemoryEntry | null }
interface StoredVersion {
  readonly version: number; readonly at: number; readonly by: LeadMemoryChangeBy
  readonly changes: readonly StoredChange[]
  readonly tidy?: { readonly merged: number; readonly replaced: number; readonly archived: number }
  readonly undone?: true
  /** Forget took text out of this version, so it can no longer be put back. */
  readonly erased?: true
  /** What the version did, counted before Forget took its words out, so its history row still says so (#2152). */
  readonly counts?: VersionCounts
  /** The person's Forget: how many notes it took out. */
  readonly forgot?: number
}
interface VersionCounts { readonly added: number; readonly removed: number; readonly changed: number }
const countsOf = (changes: readonly StoredChange[]): VersionCounts => ({
  added: changes.filter(change => !change.before && change.after).length,
  removed: changes.filter(change => change.before && !change.after).length,
  changed: changes.filter(change => change.before && change.after).length,
})
const NO_COUNTS: VersionCounts = { added: 0, removed: 0, changed: 0 }
/** One of the Lead's proposals and what the person did with it. A kept one names its entry; whether that entry is
 * still in memory is read from the entries, so Forget, Undo and a tidy's merge need no second record. */
interface StoredProposal {
  readonly id: string
  readonly kind: LeadMemoryKind
  /** Null once the person forgot the entry it became: forgotten means its words are gone. */
  readonly text: string | null
  readonly state: 'pending' | 'kept' | 'edited' | 'declined' | 'forgotten'
  readonly entry?: string
  /** When it was last proposed or decided. */
  readonly at: number
  /** What happened to it, oldest first, the newest `HISTORY_KEPT`: what the Lead may say about its past, and no more. */
  readonly history?: readonly ProposalEvent[]
}
type ProposalEvent = { readonly what: 'proposed' | 'asked-again' | 'kept' | 'edited' | 'declined' | 'forgotten'; readonly at: number }
const HISTORY_KEPT = 8
/** A No, by the proposal's normalised words and the Lead's journal position when the person said it. */
interface StoredDecline { readonly key: string; readonly seq: number }
interface StoreState {
  readonly version: 1
  readonly revision: number
  /** The number behind the next id: entries are m<n>, proposals c<n>, so a plan's (m2) keeps naming the same entry. */
  readonly next: number
  readonly auto: boolean
  readonly lastTidyAt: number | null
  readonly entries: readonly LeadMemoryEntry[]
  readonly inbox: readonly LeadMemoryCandidate[]
  /** Proposals the person said No to. The same words are offered again only once the person has written since. */
  readonly declined: readonly StoredDecline[]
  /** The Lead's recent proposals, newest last, so each request can say what became of them. */
  readonly proposals: readonly StoredProposal[]
  /** When the person last used Forget all. */
  readonly clearedAt: number | null
  readonly versions: readonly StoredVersion[]
  /** What the tidy spent on the observer model, per local day. */
  readonly spend: { readonly day: string; readonly usdMicros: number }
}
const EMPTY: StoreState = { version: 1, revision: 0, next: 1, auto: false, lastTidyAt: null, entries: [], inbox: [], declined: [], proposals: [], clearedAt: null, versions: [], spend: { day: '', usdMicros: 0 } }

/** An entry as Undo compares it: when it was last used is not a change. */
const sameEntry = (a: LeadMemoryEntry | null | undefined, b: LeadMemoryEntry | null | undefined): boolean =>
  !a || !b ? !a && !b : JSON.stringify({ ...a, usedAt: null }) === JSON.stringify({ ...b, usedAt: null })
const lastUse = (entry: LeadMemoryEntry): number => entry.usedAt ?? entry.createdAt
const numberOf = (id: string): number => Number(/\d+$/.exec(id)?.[0] ?? 0)
/** Core in the order the Lead reads it: the person's entries in the order they were made (ids are numbered as they
 * are made), then the Lead's most recently used first. */
export const leadMemoryCoreOrder = (entries: readonly LeadMemoryEntry[]): LeadMemoryEntry[] => {
  const core = entries.filter(entry => entry.tier === 'core')
  return [...core.filter(entry => entry.by === 'person').sort((a, b) => numberOf(a.id) - numberOf(b.id)),
    ...core.filter(entry => entry.by === 'lead').sort((a, b) => lastUse(b) - lastUse(a) || numberOf(b.id) - numberOf(a.id))]
}
export const leadMemoryCoreOf = (revision: number, entries: readonly LeadMemoryEntry[]): LeadMemoryCore =>
  ({ revision, entries: leadMemoryCoreOrder(entries).map(entry => ({ id: entry.id, text: entry.text, kind: entry.kind, by: entry.by })) })
/**
 * Core held to its budget: while it reads larger than `coreBytes`, the Lead's least recently used entry moves to
 * Archive, and only when none of the Lead's is left, the person's newest. Nothing is deleted. Measured at the widest
 * revision the desk can print, since the revision appears in Core twice and the journal's may run ahead of the store's.
 */
const WIDEST_REVISION = Number.MAX_SAFE_INTEGER
const fit = (entries: readonly LeadMemoryEntry[]): LeadMemoryEntry[] => {
  let out = [...entries]
  while (leadMemoryBytes(leadMemoryCoreOf(WIDEST_REVISION, out)) > LEAD_MEMORY_LIMITS.coreBytes) {
    const core = leadMemoryCoreOrder(out), victim = core.filter(entry => entry.by === 'lead').at(-1) ?? core.at(-1)
    if (!victim) break
    out = out.map(entry => entry.id === victim.id ? { ...entry, tier: 'archive' as const } : entry)
  }
  return out
}
const diff = (before: readonly LeadMemoryEntry[], after: readonly LeadMemoryEntry[]): StoredChange[] => {
  const old = new Map(before.map(entry => [entry.id, entry])), now = new Map(after.map(entry => [entry.id, entry]))
  return [...new Set([...old.keys(), ...now.keys()])].flatMap(id => sameEntry(old.get(id), now.get(id)) ? [] : [{ id, before: old.get(id) ?? null, after: now.get(id) ?? null }])
}
const summary = (version: StoredVersion, entries: readonly LeadMemoryEntry[]): LeadMemoryVersionSummary => {
  const current = new Map(entries.map(entry => [entry.id, entry]))
  const counts = version.forgot !== undefined ? NO_COUNTS : version.counts ?? countsOf(version.changes)
  return { version: version.version, at: version.at, by: version.by, ...counts,
    ...(version.tidy ? { tidy: version.tidy } : {}),
    undoable: !version.undone && !version.erased && version.changes.length > 0 && version.changes.every(change => sameEntry(current.get(change.id), change.after)),
    ...(version.undone ? { undone: true as const } : {}),
    ...(version.forgot !== undefined ? { forgotten: version.forgot } : version.erased ? { erased: true as const } : {}) }
}
const dayOf = (at: number): string => { const date = new Date(at); return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` }

const parseVersion = (value: unknown): StoredVersion => {
  const item = value as StoredVersion
  if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.version) || !Number.isSafeInteger(item.at) || !Array.isArray(item.changes)) throw new Error('lead-memory-store')
  if (!['person', 'lead', 'tidy', 'undo', 'migration'].includes(item.by)) throw new Error('lead-memory-store')
  const changes = item.changes.map(change => ({ id: String(change.id), before: change.before === null ? null : parseLeadMemoryEntry(change.before), after: change.after === null ? null : parseLeadMemoryEntry(change.after) }))
  return { version: item.version, at: item.at, by: item.by, changes, ...(item.tidy ? { tidy: { merged: Number(item.tidy.merged) || 0, replaced: Number(item.tidy.replaced) || 0, archived: Number(item.tidy.archived) || 0 } } : {}),
    ...(item.undone === true ? { undone: true as const } : {}), ...(item.erased === true ? { erased: true as const } : {}),
    ...(item.counts && typeof item.counts === 'object' ? { counts: { added: Number(item.counts.added) || 0, removed: Number(item.counts.removed) || 0, changed: Number(item.counts.changed) || 0 } } : {}),
    ...(Number.isSafeInteger(item.forgot) && item.forgot! > 0 ? { forgot: item.forgot! } : {}) }
}
const PROPOSAL_STATES = ['pending', 'kept', 'edited', 'declined', 'forgotten'] as const
/** A record the desk cannot read is dropped: it only tells the Lead what became of a proposal. */
const parseProposal = (value: unknown): StoredProposal[] => {
  const item = value as StoredProposal
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !PROPOSAL_STATES.includes(item.state) || !Number.isSafeInteger(item.at)) return []
  if (item.text !== null && (typeof item.text !== 'string' || item.text.length > LEAD_MEMORY_LIMITS.textChars)) return []
  const kind = (['preference', 'fact', 'lesson', 'rule'] as const).find(one => one === item.kind) ?? 'preference'
  const history = Array.isArray(item.history) ? item.history.filter(event => event && ['proposed', 'asked-again', 'kept', 'edited', 'declined', 'forgotten'].includes(event.what) &&
    Number.isSafeInteger(event.at)).map(event => ({ what: event.what, at: event.at })).slice(-HISTORY_KEPT) : []
  return [{ id: item.id, kind, text: item.text, state: item.state, at: item.at, ...(typeof item.entry === 'string' ? { entry: item.entry } : {}), ...(history.length ? { history } : {}) }]
}
/** A No written before the desk kept its position reads as position 0: the next thing the person writes reopens it. */
const parseDecline = (value: unknown): StoredDecline[] => {
  if (typeof value === 'string') return [{ key: value, seq: 0 }]
  const item = value as StoredDecline
  return item && typeof item === 'object' && typeof item.key === 'string' && Number.isSafeInteger(item.seq) ? [{ key: item.key, seq: item.seq }] : []
}
/**
 * A store saved before #2181 recorded the person's Keep in the Lead's words as the Lead's note. The record of that Keep
 * says otherwise: a proposal the person decided names the entry it became under an id of its own (`c<n>`), where a note
 * the Lead kept on its own is recorded under the entry's id, and the version that added the entry was the person's.
 * Either is enough. The saved versions are corrected with the entries, so an Undo never puts the old label back.
 */
const keptByThePerson = (state: StoreState): StoreState => {
  const ids = new Set([
    ...state.proposals.filter(one => one.entry !== undefined && one.entry !== one.id && (one.state === 'kept' || one.state === 'edited')).map(one => one.entry!),
    ...state.versions.filter(version => version.by === 'person').flatMap(version => version.changes.filter(change => !change.before && change.after).map(change => change.id)),
  ])
  const fix = (entry: LeadMemoryEntry | null): LeadMemoryEntry | null => entry && entry.by === 'lead' && ids.has(entry.id) ? { ...entry, by: 'person' } : entry
  if (!state.entries.some(entry => fix(entry) !== entry)) return state
  return { ...state, entries: state.entries.map(entry => fix(entry)!),
    versions: state.versions.map(version => ({ ...version, changes: version.changes.map(change => ({ ...change, before: fix(change.before), after: fix(change.after) })) })) }
}
const parseStore = (value: unknown): StoreState => keptByThePerson(parseStoreAsSaved(value))
const parseStoreAsSaved = (value: unknown): StoreState => {
  const item = value as StoreState
  if (!item || typeof item !== 'object' || item.version !== 1 || !Number.isSafeInteger(item.revision) || !Number.isSafeInteger(item.next)) throw new Error('lead-memory-store')
  const entries = (item.entries ?? []).map(entry => parseLeadMemoryEntry(entry)), inbox = (item.inbox ?? []).map(candidate => parseLeadMemoryCandidate(candidate))
  if (new Set([...entries.map(entry => entry.id), ...inbox.map(candidate => candidate.id)]).size !== entries.length + inbox.length) throw new Error('lead-memory-store')
  return { version: 1, revision: item.revision, next: item.next, auto: item.auto === true, lastTidyAt: Number.isSafeInteger(item.lastTidyAt) ? item.lastTidyAt : null,
    entries, inbox, declined: ((item.declined ?? []) as unknown[]).flatMap(parseDecline).slice(-LEAD_MEMORY_LIMITS.declined),
    proposals: ((item.proposals ?? []) as unknown[]).flatMap(parseProposal).slice(-LEAD_MEMORY_LIMITS.proposals),
    clearedAt: Number.isSafeInteger(item.clearedAt) ? item.clearedAt : null,
    versions: (item.versions ?? []).map(parseVersion).slice(-LEAD_MEMORY_LIMITS.versions),
    spend: item.spend && typeof item.spend.day === 'string' && Number.isSafeInteger(item.spend.usdMicros) ? item.spend : EMPTY.spend }
}

/** What the tidy may do, by the Lead's entries only: merge several into one sentence, or drop one a newer entry
 * replaces. The desk checks every id and scans every merged sentence before anything changes. */
export interface LeadMemoryTidyPlan {
  readonly merge: readonly { readonly ids: readonly string[]; readonly text: string }[]
  readonly drop: readonly { readonly id: string; readonly by: string }[]
}
export type LeadMemoryTidyOutcome =
  | { readonly outcome: 'applied'; readonly version: number; readonly merged: number; readonly replaced: number; readonly archived: number }
  | { readonly outcome: 'nothing' }
  | { readonly outcome: 'refused'; readonly reason: 'loss' | 'invalid' }

export interface LeadMemoryStoreOptions {
  /** `<home>/lead`. */
  readonly dir: string
  readonly now?: () => number
  /** The person-edited lines kept before this store: migrated once, with nothing lost. */
  readonly legacy?: () => Promise<LeadMemory | null>
  /** Forget reaches past the store: the texts of a forgotten entry, every version of it, or `'all'` for Forget all,
   * so the conversation search reads loses them too. Runs before the store changes; a failure leaves the entry. */
  readonly onForget?: (texts: readonly string[] | 'all') => Promise<void>
}
export class LeadMemoryStore {
  #state: StoreState = EMPTY
  #tail: Promise<unknown> = Promise.resolve()
  #listeners = new Set<(revision: number) => void>()
  readonly #now: () => number
  private constructor(private readonly options: LeadMemoryStoreOptions) { this.#now = options.now ?? Date.now }

  static async open(options: LeadMemoryStoreOptions): Promise<LeadMemoryStore> {
    const store = new LeadMemoryStore(options)
    await store.#open()
    return store
  }
  async #open(): Promise<void> {
    const file = join(this.options.dir, FILE), read = await readBoundedJsonResult(file, FILE_BYTES)
    if (read.kind === 'value') {
      try { this.#state = parseStore(read.value); return } catch { /* Kept aside below, never overwritten. */ }
    }
    if (read.kind === 'io') throw new Error('lead-memory-unreadable')
    // A file the desk cannot read is set aside rather than written over, so nothing in it is lost.
    if (read.kind !== 'missing') await rename(file, join(this.options.dir, `memory-store.unreadable-${this.#now()}.json`)).catch(() => {})
    await this.#migrate()
  }
  /** Today's person-edited lines become the person's entries, in their order and numbering, Core first until it is
   * full and Archive after; nothing of them is dropped, since they are the person's. Lines the Lead offered pass the
   * same scan as a proposal on their way to the inbox, and one it refuses is left out. */
  async #migrate(): Promise<void> {
    const legacy = await this.options.legacy?.().catch(() => null) ?? null, at = this.#now()
    const entries: LeadMemoryEntry[] = [], inbox: LeadMemoryCandidate[] = []
    for (const item of legacy?.items ?? []) {
      if (item.state === 'kept') {
        // Kept lines count on their own, m1, m2, ..., the way the instructions numbered them, so a plan's (m2) still
        // names the same line; offered lines count apart, c1, c2, ...
        const text = leadMemoryFold(item.text).slice(0, LEAD_MEMORY_LIMITS.textChars) || item.text
        entries.push({ id: `m${entries.length + 1}`, text, kind: 'preference', by: 'person', tier: 'core', source: { kind: 'settings', id: 'migration' }, createdAt: item.at, usedAt: null, version: 1 })
      } else {
        const scan = leadMemoryScan(item.text)
        if (scan.ok) inbox.push({ id: `c${inbox.length + 1}`, text: scan.text, kind: 'preference', source: { kind: 'message', id: item.id }, proposedAt: item.at, afterSeq: 0 })
      }
    }
    const next = Math.max(entries.length, inbox.length) + 1
    const placed = fit(entries)
    const changes = diff([], placed)
    this.#state = { ...EMPTY, next, entries: placed, inbox, revision: changes.length || inbox.length ? 1 : 0,
      versions: changes.length ? [{ version: 1, at, by: 'migration', changes }] : [] }
    // Nothing to carry across writes nothing: the file appears with the first change.
    if (this.#state.revision > 0) await this.#save()
  }
  async #save(): Promise<void> { await writeAtomicJson(join(this.options.dir, FILE), this.#state, async () => {}) }
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation)
    this.#tail = next.catch(() => {})
    return next
  }
  /** One change: the entries refit to Core's budget, a version when they changed, the revision bumped and saved. */
  async #commit(next: Partial<StoreState>, by: LeadMemoryChangeBy, extra: Pick<StoredVersion, 'tidy' | 'forgot'> = {}): Promise<number | null> {
    const before = this.#state.entries, entries = next.entries ? fit(next.entries) : before
    const changes = diff(before, entries)
    let versions = next.versions ?? this.#state.versions, version: number | null = null
    if (changes.length) {
      version = (versions.at(-1)?.version ?? 0) + 1
      versions = [...versions, { version, at: this.#now(), by, changes, ...extra }].slice(-LEAD_MEMORY_LIMITS.versions)
    }
    this.#state = { ...this.#state, ...next, entries, versions, revision: this.#state.revision + 1 }
    await this.#save()
    for (const listener of this.#listeners) { try { listener(this.#state.revision) } catch { /* A listener never blocks a change. */ } }
    return version
  }
  onChange(listener: (revision: number) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  get revision(): number { return this.#state.revision }
  get auto(): boolean { return this.#state.auto }
  get lastTidyAt(): number | null { return this.#state.lastTidyAt }
  entries(): readonly LeadMemoryEntry[] { return this.#state.entries }
  archive(): readonly LeadMemoryEntry[] { return this.#state.entries.filter(entry => entry.tier === 'archive') }
  inbox(): readonly LeadMemoryCandidate[] { return this.#state.inbox }
  /** Core as the Lead reads it, for the journal. */
  core(revision = this.#state.revision): LeadMemoryCore { return leadMemoryCoreOf(revision, this.#state.entries) }
  view(): LeadMemoryView {
    const { entries } = this.#state, core = leadMemoryCoreOrder(entries)
    return { version: 1, revision: this.#state.revision, core, archive: entries.filter(entry => entry.tier === 'archive').sort((a, b) => lastUse(b) - lastUse(a)),
      inbox: this.#state.inbox, history: [...this.#state.versions].reverse().map(version => summary(version, entries)),
      coreBytes: leadMemoryBytes(this.core()), auto: this.#state.auto, lastTidyAt: this.#state.lastTidyAt }
  }

  /** The proposal records with this one put last, as the newest, within their bound. */
  #recorded(record: StoredProposal, list: readonly StoredProposal[] = this.#state.proposals): StoredProposal[] {
    // Each record adds what happened to the proposal's history: the first pending is the proposal, a later one is the
    // Lead asking again; a decision is named by its state. Re-recording the same state at the same time adds nothing.
    const old = list.find(one => one.id === record.id), before = old?.history ?? []
    const what: ProposalEvent['what'] = record.state === 'pending' ? (old ? 'asked-again' : 'proposed') : record.state
    const last = before.at(-1)
    const history = last && last.what === what && last.at === record.at ? before : [...before, { what, at: record.at }].slice(-HISTORY_KEPT)
    return [...list.filter(one => one.id !== record.id), { ...record, history }].slice(-LEAD_MEMORY_LIMITS.proposals)
  }
  /** The record of a proposal the person just decided: from the one kept at proposing, or from the candidate itself
   * when it reached the inbox another way (carried over from the earlier lines). */
  #decided(candidate: LeadMemoryCandidate, state: StoredProposal['state'], at: number, entry?: string, list: readonly StoredProposal[] = this.#state.proposals): StoredProposal[] {
    const old = list.find(one => one.id === candidate.id)
    return this.#recorded({ id: candidate.id, kind: old?.kind ?? candidate.kind, text: candidate.text, state, at, ...(entry ? { entry } : {}) }, list)
  }

  /**
   * The Lead's proposal: scanned, then checked against what is kept (`exists`, with the entry's id), what already waits
   * for the person (`pending`, with its id: the Keep chip moves under the reply this turn writes, so the person sees it
   * again rather than a second copy) and what the person declined. A declined proposal is refused until the person has
   * written since their No (`personSeq`, the journal position of their latest message, is past the No's); then it is
   * offered again, and the result says it was declined before. Otherwise it goes to the inbox (`created`), or is kept
   * at once when the person turned on keeping the Lead's notes, for facts and lessons (`kept`). `afterSeq` is the
   * Lead's journal position, so the Keep chip sits under the reply that follows. Only the desk's answer says whether a
   * note is in memory; the Lead's words never do.
   */
  propose(proposal: LeadMemoryProposal, afterSeq: number, personSeq = 0): Promise<LeadMemoryProposalResult> {
    return this.#serial(async () => {
      const scan = leadMemoryScan(proposal.text)
      if (!scan.ok) return { outcome: 'refused' as const, reason: scan.reason }
      const text = scan.text, at = this.#now(), key = leadMemoryKey(text), seq = Math.max(0, Math.floor(afterSeq))
      const repeat = this.#state.entries.find(entry => leadMemoryNear(entry.text, text))
      if (repeat) {
        // Saying it again is using it: it stays in Core longer.
        this.#state = { ...this.#state, entries: this.#state.entries.map(entry => entry.id === repeat.id ? { ...entry, usedAt: at } : entry) }
        await this.#save()
        return { outcome: 'exists' as const, id: repeat.id }
      }
      const waiting = this.#state.inbox.find(candidate => leadMemoryNear(candidate.text, text))
      if (waiting) {
        await this.#commit({ inbox: this.#state.inbox.map(candidate => candidate.id === waiting.id ? { ...candidate, afterSeq: Math.max(candidate.afterSeq, seq), askedAgainAt: at } : candidate),
          proposals: this.#decided(waiting, 'pending', at) }, 'lead')
        return { outcome: 'pending' as const, id: waiting.id }
      }
      const declined = this.#state.declined.filter(old => old.key === key || leadMemoryNear(old.key, key))
      if (declined.some(old => personSeq <= old.seq)) {
        const record = [...this.#state.proposals].reverse().find(one => one.state === 'declined' && one.text !== null && leadMemoryNear(one.text, text))
        return { outcome: 'refused' as const, reason: 'declined' as const, ...(record ? { id: record.id } : {}) }
      }
      // The person said it again after their No: the No no longer stands in the way, and a second No records it again.
      const reopened = declined.length ? { declined: this.#state.declined.filter(old => !declined.includes(old)) } : {}
      const before = declined.length ? { declinedBefore: true as const } : {}
      const source = proposal.source ?? { kind: 'message' as const, id: 'reply' }
      if (this.#state.auto && (proposal.kind === 'fact' || proposal.kind === 'lesson') && this.#state.entries.length < LEAD_MEMORY_LIMITS.entries) {
        const id = `m${this.#state.next}`
        await this.#commit({ ...reopened, next: this.#state.next + 1, entries: [...this.#state.entries, { id, text, kind: proposal.kind, by: 'lead', tier: 'core', source, createdAt: at, usedAt: at, version: 1 }],
          proposals: this.#recorded({ id, kind: proposal.kind, text, state: 'kept', entry: id, at }) }, 'lead')
        return { outcome: 'kept' as const, id }
      }
      if (this.#state.inbox.length >= LEAD_MEMORY_LIMITS.inbox) return { outcome: 'refused' as const, reason: 'inbox-full' as const }
      const id = `c${this.#state.next}`
      await this.#commit({ ...reopened, next: this.#state.next + 1, inbox: [...this.#state.inbox, { id, text, kind: proposal.kind, source, proposedAt: at, afterSeq: seq }],
        proposals: this.#recorded({ id, kind: proposal.kind, text, state: 'pending', at }) }, 'lead')
      return { outcome: 'created' as const, id, ...before }
    })
  }

  /**
   * What became of the Lead's recent proposals, newest first, with Core now and every entry's id: what each request
   * tells the Lead (`leadMemoryStatus`), since the Core in its standing instructions is frozen for the epoch. A kept
   * proposal whose entry a tidy merged reads as kept in the merged entry, with the entry's words as they are now; one
   * whose entry is gone reads as forgotten (Forget), undone (Undo) or removed (any other way, such as an older client
   * writing the list without it).
   */
  status(): LeadMemoryStatus {
    const seen = (record: StoredProposal) => record.history?.length ? { history: record.history.map(event => ({ ...event })) } : {}
    const { entries, inbox } = this.#state, byId = new Map(entries.map(entry => [entry.id, entry]))
    const waiting = new Set(inbox.map(candidate => candidate.id))
    const live = (id: string | undefined): LeadMemoryEntry | undefined => {
      for (let at = id, hops = 0; at && hops < 8; hops++) {
        const found = byId.get(at)
        if (found) return found
        at = entries.find(entry => entry.source.kind === 'consolidation' && entry.source.id.split(',').includes(at!))?.id
      }
      return undefined
    }
    const proposals = [...this.#state.proposals].reverse().flatMap((record): LeadMemoryProposalStatus[] => {
      if (record.state === 'pending') return waiting.has(record.id) ? [{ id: record.id, state: 'pending' as const, text: record.text, at: record.at, ...seen(record) }] : []
      if (record.state !== 'kept' && record.state !== 'edited') return [{ id: record.id, state: record.state, text: record.text, at: record.at, ...seen(record) }]
      const entry = live(record.entry)
      if (!entry) {
        // Forget marks its own records; an entry gone any other way was undone or replaced, and says which.
        const undone = this.#state.versions.some(version => version.by === 'undo' && version.changes.some(change => change.before?.id === record.entry && !change.after))
        return [{ id: record.id, state: undone ? 'undone' as const : 'removed' as const, text: record.text, at: record.at, ...seen(record) }]
      }
      // A tidy's merge is still the note kept; the person's own edit makes it theirs. Either way the words are the
      // entry's as they stand now, never the ones it replaced.
      const state: LeadMemoryProposalState = record.state === 'edited' || (entry.id === record.entry && entry.text !== record.text) ? 'edited' : 'kept'
      return [{ id: record.id, state, text: entry.text, entry: entry.id, at: record.at, ...seen(record) }]
    })
    return { revision: this.#state.revision, proposals, core: leadMemoryCoreOrder(entries).map(entry => ({ id: entry.id, text: entry.text })),
      entries: entries.map(entry => entry.id), clearedAt: this.#state.clearedAt }
  }

  /** What the person does, in Settings or on a Keep chip. `seq` is the Lead's journal position, which a No keeps: the
   * same words are offered again only after the person writes past it. `kept` hears the entry a Keep made, inside this
   * change's own turn of the queue, so two Keeps at once each name their own entry (#2176). */
  change(change: LeadMemoryChange, seq = 0, kept?: (entry: LeadMemoryEntry) => void): Promise<LeadMemoryView> {
    return this.#serial(async () => {
      const { entries, inbox } = this.#state, at = this.#now()
      const entry = (id: string) => entries.find(one => one.id === id) ?? (() => { throw leadRefusal('lead-memory-missing') })()
      const room = () => { if (entries.length >= LEAD_MEMORY_LIMITS.entries) throw leadRefusal('lead-memory-full') }
      const words = (text: string) => {
        const folded = leadMemoryFold(text)
        if (!folded || folded.length > LEAD_MEMORY_LIMITS.textChars) throw leadRefusal('lead-operation-refused')
        // The person's own words still never carry a credential into the Lead's instructions.
        if (leadMemoryHasSecret(text)) throw leadRefusal('lead-secret-refused')
        return folded
      }
      const placed = (next: readonly LeadMemoryEntry[], id: string, tier: 'core' | 'archive') => {
        if (tier === 'core' && fit(next).find(one => one.id === id)?.tier !== 'core') throw leadRefusal('lead-memory-core-full')
        return next
      }
      switch (change.action) {
        case 'add': {
          room()
          const id = `m${this.#state.next}`, tier = change.tier ?? 'core'
          await this.#commit({ next: this.#state.next + 1, entries: placed([...entries, { id, text: words(change.text), kind: change.kind, by: 'person', tier,
            source: { kind: 'settings', id: 'settings' }, createdAt: at, usedAt: null, version: 1 }], id, tier) }, 'person')
          break
        }
        case 'edit': {
          const old = entry(change.id), text = words(change.text)
          // An edit makes the entry the person's words.
          await this.#commit({ entries: entries.map(one => one.id === old.id ? { ...one, text, kind: change.kind ?? one.kind, by: 'person', version: one.version + 1 } : one) }, 'person')
          break
        }
        case 'keep': {
          const candidate = inbox.find(one => one.id === change.id)
          if (!candidate) throw leadRefusal('lead-memory-missing')
          room()
          const text = change.text === undefined ? candidate.text : words(change.text), edited = leadMemoryFold(text) !== leadMemoryFold(candidate.text)
          const id = `m${this.#state.next}`
          // The person made it a memory, so it is the person's, in the Lead's words or their own (#2181).
          const made: LeadMemoryEntry = { id, text, kind: change.kind ?? candidate.kind, by: 'person', tier: 'core', source: candidate.source, createdAt: at, usedAt: at, version: 1 }
          await this.#commit({ next: this.#state.next + 1, inbox: inbox.filter(one => one.id !== candidate.id),
            entries: [...entries, made], proposals: this.#decided(candidate, edited ? 'edited' : 'kept', at, id) }, 'person')
          kept?.(made)
          break
        }
        case 'dismiss': {
          const candidate = inbox.find(one => one.id === change.id)
          if (!candidate) throw leadRefusal('lead-memory-missing')
          await this.#commit({ inbox: inbox.filter(one => one.id !== candidate.id), declined: [...this.#state.declined, { key: leadMemoryKey(candidate.text), seq: Math.max(0, Math.floor(seq)) }].slice(-LEAD_MEMORY_LIMITS.declined),
            proposals: this.#decided(candidate, 'declined', at) }, 'person')
          break
        }
        case 'move': {
          const old = entry(change.id)
          if (old.tier !== change.tier) await this.#commit({ entries: placed(entries.map(one => one.id === old.id ? { ...one, tier: change.tier, ...(change.tier === 'core' ? { usedAt: at } : {}) } : one), old.id, change.tier) }, 'person')
          break
        }
        case 'forget': {
          const old = entry(change.id)
          // The note and every version of it, and the notes a tidy merged into it (and theirs), which no longer stand
          // on their own: their wording is the note's too.
          const gone = new Set([old.id]), live = new Set(entries.map(one => one.id))
          for (const id of gone) {
            for (const version of this.#state.versions) for (const one of version.changes) for (const side of [one.before, one.after]) {
              if (side?.id !== id || side.source.kind !== 'consolidation') continue
              for (const part of side.source.id.split(',')) if (part && !live.has(part)) gone.add(part)
            }
          }
          const texts = new Set([old.text, ...this.#state.versions.flatMap(version => version.changes.filter(one => gone.has(one.id)).flatMap(one => [one.before?.text, one.after?.text]))
            .filter((text): text is string => typeof text === 'string')])
          await this.options.onForget?.([...texts])
          // What the Lead proposed and the person kept as this note is forgotten too, and its words go with it.
          const proposals = this.#state.proposals.map(one => (one.entry && gone.has(one.entry)) || (one.text !== null && texts.has(one.text))
            ? { ...one, state: 'forgotten' as const, text: null, at } : one)
          await this.#commit({ entries: entries.filter(one => one.id !== old.id), proposals }, 'person', { forgot: 1 })
          // Forgotten means gone: the text leaves every version too, and those versions can no longer be undone. Each
          // keeps its counts, so the history still says what it did and that Forget came after.
          this.#state = { ...this.#state, versions: this.#state.versions.map(version => version.changes.some(one => gone.has(one.id))
            ? { ...version, counts: version.counts ?? countsOf(version.changes), changes: version.changes.filter(one => !gone.has(one.id)), erased: true as const } : version) }
          await this.#save()
          break
        }
        case 'forget-all':
          await this.options.onForget?.('all')
          await this.#commit({ entries: [], inbox: [], declined: [], proposals: [], clearedAt: at }, 'person')
          this.#state = { ...this.#state, versions: [] }
          await this.#save()
          break
        case 'auto':
          if (this.#state.auto !== change.on) await this.#commit({ auto: change.on }, 'person')
          break
        case 'undo': {
          const target = this.#state.versions.find(version => version.version === change.version)
          if (!target || !summary(target, entries).undoable) throw leadRefusal('lead-memory-stale')
          const restored = new Map(entries.map(one => [one.id, one]))
          for (const one of target.changes) { if (one.before) restored.set(one.id, one.before); else restored.delete(one.id) }
          const order = [...entries.map(one => one.id), ...target.changes.map(one => one.id)]
          const next = [...new Set(order)].flatMap(id => restored.has(id) ? [restored.get(id)!] : [])
          await this.#commit({ entries: next, versions: this.#state.versions.map(version => version.version === target.version ? { ...version, undone: true as const } : version) }, 'undo')
          break
        }
      }
      return this.view()
    })
  }

  /** A search or a repeat used these entries: they stay in Core longer. No version: nothing the person wrote changed. */
  touch(ids: readonly string[]): Promise<void> {
    if (!ids.length) return Promise.resolve()
    return this.#serial(async () => {
      const at = this.#now(), used = new Set(ids)
      this.#state = { ...this.#state, entries: this.#state.entries.map(entry => used.has(entry.id) ? { ...entry, usedAt: at } : entry) }
      await this.#save()
    })
  }

  /** The person-edited lines as `lead/memory/read` has always returned them: the person's entries kept, the inbox offered. */
  legacy(): LeadMemory {
    const kept = this.#state.entries.filter(entry => entry.by === 'person').sort((a, b) => numberOf(a.id) - numberOf(b.id))
    return { version: 1, items: [...kept.map(entry => ({ id: entry.id, text: entry.text, state: 'kept' as const, at: entry.createdAt })),
      ...this.#state.inbox.map(candidate => ({ id: candidate.id, text: candidate.text, state: 'suggested' as const, at: candidate.proposedAt }))].slice(0, LEAD_SCHEDULE_LIMITS.memory) }
  }
  /** `lead/memory/update` as before: the list it sends is the person's lines and the offered ones. A kept line is the
   * person's entry (an offered one it kept becomes one); a line left out is forgotten or declined. */
  replaceLegacy(memory: LeadMemory, seq = 0): Promise<LeadMemory> {
    return this.#serial(async () => {
      const at = this.#now(), items = new Map(memory.items.map(item => [item.id, item]))
      let proposals = this.#state.proposals
      let next = this.#state.next
      const entries = this.#state.entries.flatMap(entry => {
        if (entry.by !== 'person') return [entry]
        const item = items.get(entry.id)
        if (!item || item.state !== 'kept') return []
        const text = leadMemoryFold(item.text)
        return [text === entry.text ? entry : { ...entry, text, version: entry.version + 1 }]
      })
      const added: LeadMemoryEntry[] = []
      for (const item of memory.items) {
        if (item.state !== 'kept' || entries.some(entry => entry.id === item.id)) continue
        const text = leadMemoryFold(item.text)
        if (!text || leadMemoryHasSecret(text)) continue
        const id = `m${next++}`, offered = this.#state.inbox.find(candidate => candidate.id === item.id)
        added.push({ id, text, kind: 'preference', by: 'person', tier: 'core', source: { kind: 'settings', id: 'settings' }, createdAt: at, usedAt: null, version: 1 })
        if (offered) proposals = this.#decided(offered, leadMemoryFold(offered.text) === text ? 'kept' : 'edited', at, id, proposals)
      }
      const inbox = this.#state.inbox.filter(candidate => items.get(candidate.id)?.state === 'suggested')
      const left = this.#state.inbox.filter(candidate => !items.has(candidate.id))
      for (const candidate of left) proposals = this.#decided(candidate, 'declined', at, undefined, proposals)
      const declined = left.map(candidate => ({ key: leadMemoryKey(candidate.text), seq: Math.max(0, Math.floor(seq)) }))
      await this.#commit({ next, proposals, entries: [...entries, ...added].slice(0, LEAD_MEMORY_LIMITS.entries), inbox, declined: [...this.#state.declined, ...declined].slice(-LEAD_MEMORY_LIMITS.declined) }, 'person')
      return this.legacy()
    })
  }

  /** Whether a tidy may run now: at most once in `tidyEveryMs`, with the Lead's entries to tidy, and inside today's cap. */
  tidyDue(): boolean {
    const at = this.#now(), last = this.#state.lastTidyAt
    return (last === null || at - last >= LEAD_MEMORY_LIMITS.tidyEveryMs) && this.tidyBudget() > 0 && this.#state.entries.some(entry => entry.by === 'lead')
  }
  /** What the tidy may still spend today, in micro-dollars. */
  tidyBudget(): number {
    const spend = this.#state.spend.day === dayOf(this.#now()) ? this.#state.spend.usdMicros : 0
    return Math.max(0, LEAD_MEMORY_LIMITS.tidyDailyUsdMicros - spend)
  }
  /** Records what a tidy's model request cost, applied or not. */
  spent(usdMicros: number): Promise<void> {
    return this.#serial(async () => {
      const day = dayOf(this.#now()), before = this.#state.spend.day === day ? this.#state.spend.usdMicros : 0
      this.#state = { ...this.#state, spend: { day, usdMicros: before + Math.max(0, Math.round(usdMicros)) }, lastTidyAt: this.#now() }
      await this.#save()
    })
  }
  /**
   * One tidy, applied whole or not at all, as one version Undo can put back. Only the Lead's entries can be merged or
   * dropped; a merged sentence passes the same scan as a proposal; the Lead's Core entries nobody used in
   * `unusedMs` move to Archive. A tidy after which no entry says more than `tidyLossShare` of the words the Lead's entries said is refused.
   */
  // A merge is the observer model's call on which notes say the same thing; it is not held to leadMemoryNear's
  // polarity check, so its own instructions ("never merge notes that differ") are what keep a note from its negation.
  tidy(plan: LeadMemoryTidyPlan): Promise<LeadMemoryTidyOutcome> {
    return this.#serial(async () => {
      const at = this.#now(), entries = this.#state.entries, byId = new Map(entries.map(entry => [entry.id, entry]))
      const leads = (id: string) => byId.get(id)?.by === 'lead'
      const used = new Set<string>()
      const claim = (id: string) => { if (!leads(id) || used.has(id)) throw new Error('invalid'); used.add(id) }
      let next = [...entries], merged = 0, replaced = 0, counter = this.#state.next
      try {
        for (const drop of plan.drop) {
          claim(drop.id)
          if (!byId.has(drop.by) || drop.by === drop.id || byId.get(drop.by)!.createdAt < byId.get(drop.id)!.createdAt) throw new Error('invalid')
          next = next.filter(entry => entry.id !== drop.id); replaced++
        }
        for (const merge of plan.merge) {
          if (merge.ids.length < 2) throw new Error('invalid')
          merge.ids.forEach(claim)
          const scan = leadMemoryScan(merge.text)
          if (!scan.ok) throw new Error('invalid')
          const parts = merge.ids.map(id => byId.get(id)!)
          const kind: LeadMemoryKind = parts.every(part => part.kind === parts[0]!.kind) ? parts[0]!.kind : 'fact'
          next = [...next.filter(entry => !merge.ids.includes(entry.id)), { id: `m${counter++}`, text: scan.text, kind, by: 'lead',
            tier: parts.some(part => part.tier === 'core') ? 'core' : 'archive', source: { kind: 'consolidation', id: merge.ids.join(',').slice(0, 256) },
            createdAt: at, usedAt: Math.max(...parts.map(lastUse)), version: 1 }]
          merged += merge.ids.length
        }
      } catch { return { outcome: 'refused' as const, reason: 'invalid' as const } }
      let archived = 0
      next = next.map(entry => {
        if (entry.by !== 'lead' || entry.tier !== 'core' || at - lastUse(entry) < LEAD_MEMORY_LIMITS.unusedMs) return entry
        archived++
        return { ...entry, tier: 'archive' as const }
      })
      // Loss is the share of the distinct words in the Lead's entries no entry says any more: a merge that keeps every
      // fact loses little however much shorter it is, and moving an unused entry to Archive loses nothing.
      const words = (list: readonly LeadMemoryEntry[]) => new Set(list.filter(entry => entry.by === 'lead').flatMap(entry => leadMemoryTokens(entry.text)))
      const before = words(entries), after = words(next)
      const lost = [...before].filter(word => !after.has(word)).length
      if (before.size > 0 && lost / before.size > LEAD_MEMORY_LIMITS.tidyLossShare) return { outcome: 'refused' as const, reason: 'loss' as const }
      if (!diff(entries, fit(next)).length) return { outcome: 'nothing' as const }
      const version = await this.#commit({ next: counter, entries: next }, 'tidy', { tidy: { merged, replaced, archived } })
      return { outcome: 'applied' as const, version: version!, merged, replaced, archived }
    })
  }
}
