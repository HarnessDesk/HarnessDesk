import { appendFile, lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LEAD_CONTEXT, leadCheckpointInstruction, leadCheckpointMessages, leadCheckpointRefusal, leadCheckpointText, leadCheckpointTurn,
  leadContextBoundary, leadContextBytes, leadContextMarkOf, leadContextPressure, leadContextSplit, leadContextWindow, leadEstimatedTokens,
  leadCheckpointCompose, leadFallbackCheckpoint, leadFitTurns, leadHistory, leadMergedTurns, leadNextSoftShare, leadPairedTurns, leadPersonSection,
  leadPruneContext, parseLeadContextTurns, LEAD_CONTEXT_UNCOUNTED,
  type LeadCompactionTrigger, type LeadContextMark, type LeadContextRecordInput, type LeadJournal, type LeadMessagesRequest,
  type LeadMessagesResult, type MessagesText, type MessagesTurn,
} from '@harnessdesk/lead'
import { parseLeadContextFacts, type LeadContextCheckpoint, type LeadContextFacts } from '@harnessdesk/protocol'
import { readBoundedJson, writeAtomicJson } from './bounded-json.js'

/**
 * The Lead's stored conversation, owned by the host: provider-shaped turns with their tool pairs, the desk context
 * of each moment left as a one-line stub, and no reasoning. The child records what each step adds and reads it back
 * after a compaction; the host builds each of its own requests from it. It lives in `<home>/lead/context.jsonl`, is
 * never larger than `LEAD_CONTEXT.diskBytes`, and is replaced only through the journal (`context-compaction-*`), so a
 * crash at any point leaves either the old conversation or the new one, never a mix.
 */
const FILE = 'context.jsonl', NEXT = 'context.next.jsonl', CHECKPOINTS = 'context-checkpoints.json'
const PERSON_REFERENCE = 'Desk reference for the preceding person message: '
const KNOWN = 1024, CHECKPOINT_LIST = 8, READ_BYTES = 1_000_000

interface Header {
  readonly type: 'header'; readonly version: 1; readonly epoch: number
  /** Person messages already in the conversation, or folded into a checkpoint: never imported twice. */
  readonly known: readonly string[]
  /** Tokens a request carries beyond its turns (instructions, tools, framing), as last measured. */
  readonly overhead: number
  readonly softAt: number
}
interface RecordLine {
  readonly type: 'record'; readonly base: number; readonly extend: readonly MessagesText[]; readonly turns: readonly MessagesTurn[]
  /** The provider's count for the request, against the stored bytes it began from. */
  readonly measured: { readonly tokens: number; readonly bytes: number } | null
}
export interface LeadContextStoreOptions {
  /** `<home>/lead`, already created by the journal. */
  readonly directory: string
  readonly journal: LeadJournal
  readonly model: string
  readonly now: () => number
  readonly nextId: () => string
  /** Test seam: a smaller window than the model's. */
  readonly window?: number
}
export type LeadContextSend = (input: LeadMessagesRequest) => Promise<LeadMessagesResult>
/** `stopped`: the run ended without a checkpoint because the request was refused (budget, a stop) or the host could
 * not reach the Lead; nothing was replaced and the breaker did not count it. */
export type LeadCompactionOutcome = 'applied' | 'pruned' | 'nothing' | 'busy' | 'stopped'
/** What the store learns once the rest of the host exists. */
export interface LeadContextConnections {
  /** Work ids every checkpoint must name: the open cards on the work ledger. */
  readonly ledgerIds?: () => Promise<readonly string[]>
  /** The same screen a reply passes before the person sees it; throws when the text must not be shown. */
  readonly screen?: (text: string) => Promise<void>
}

const personIds = (turns: readonly MessagesTurn[]): string[] => turns.flatMap(turn => turn.role !== 'user' ? [] : turn.content.flatMap(block =>
  block.type === 'text' && block.text.startsWith(PERSON_REFERENCE) ? [block.text.slice(PERSON_REFERENCE.length).trim()] : []))
const integer = (value: unknown, fallback: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
const textBlocks = (value: unknown): MessagesText[] => {
  if (!Array.isArray(value) || !value.length) return []
  return parseLeadContextTurns([{ role: 'user', content: value }]).turns[0]!.content.filter((block): block is MessagesText => block.type === 'text')
}

export class LeadContextStore {
  #turns: readonly MessagesTurn[] = []
  #epoch = 0
  #known: string[] = []
  #overhead = 0
  #softAt: number = LEAD_CONTEXT.softShare
  #measured: RecordLine['measured'] = null
  #checkpoints: LeadContextCheckpoint[] = []
  #compacting = false
  /** Pressure after a compaction that could not bring the conversation under the hard line; no compaction is due
   * again until it rises past this by the hysteresis. */
  #fullAt: number | null = null
  #connections: LeadContextConnections = {}
  #fileBytes = 0
  #tail: Promise<unknown> = Promise.resolve()
  private constructor(private readonly options: LeadContextStoreOptions) {}

  static async open(options: LeadContextStoreOptions): Promise<LeadContextStore> {
    const store = new LeadContextStore(options)
    await store.#open()
    return store
  }
  /** Wire in what the host builds after the store: the work ledger and the reply screen. */
  connect(connections: LeadContextConnections): Promise<void> {
    this.#connections = { ...this.#connections, ...connections }
    const screen = connections.screen
    if (!screen) return Promise.resolve()
    // Checkpoints kept from before the screen was wired pass it too before they are shown.
    return this.#serial(async () => {
      this.#checkpoints = await Promise.all(this.#checkpoints.map(async checkpoint => {
        if (checkpoint.text === null) return checkpoint
        try { await screen(checkpoint.text); return checkpoint } catch { return { ...checkpoint, text: null } }
      }))
    })
  }
  get epoch(): number { return this.#epoch }
  get window(): number { return this.options.window ?? leadContextWindow(this.options.model) }
  /** The stored turns, for tests and the checkpoint view. */
  get turns(): readonly MessagesTurn[] { return this.#turns }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work)
    this.#tail = next.catch(() => {})
    return next
  }
  #path(name: string) { return join(this.options.directory, name) }

  async #open(): Promise<void> {
    const { journal } = this.options
    const settled = journal.state.context.epoch
    // A compaction written but not yet in place: the journal says which side of it the desk is on.
    const next = await this.#load(NEXT)
    if (next && next.header.epoch === settled) await rename(this.#path(NEXT), this.#path(FILE))
    else await rm(this.#path(NEXT), { force: true })
    const current = await this.#load(FILE)
    if (current && current.header.epoch === settled) { this.#adopt(current.header, current.turns, current.measured); this.#fileBytes = current.bytes }
    else await this.#seed(settled)
    const kept = await readBoundedJson(this.#path(CHECKPOINTS), 600_000) as { version?: unknown; checkpoints?: unknown } | undefined
    if (kept?.version === 1 && Array.isArray(kept.checkpoints)) {
      try { this.#checkpoints = [...parseLeadContextFacts({ version: 1, windowTokens: 1, usedTokens: null, cacheHitRate: null, compacting: false, checkpoints: kept.checkpoints.slice(-CHECKPOINT_LIST) }).checkpoints] }
      catch { this.#checkpoints = [] }
    }
    // The desk stopped between started and applied: the old conversation stands, and the run is not a failure.
    const pending = journal.state.context.pending
    if (pending) await journal.contextCompactionFailed(pending.id, 'interrupted')
  }
  async #load(name: string): Promise<{ header: Header; turns: MessagesTurn[]; measured: RecordLine['measured']; bytes: number } | null> {
    let text: string
    try {
      if ((await lstat(this.#path(name))).isSymbolicLink()) return null
      text = await readFile(this.#path(name), 'utf8')
    } catch { return null }
    if (Buffer.byteLength(text) > LEAD_CONTEXT.diskBytes * 2) return null
    const lines = text.split('\n')
    try {
      const raw = JSON.parse(lines[0]!) as Record<string, unknown>
      if (raw.type !== 'header' || raw.version !== 1 || !Array.isArray(raw.known)) return null
      const header: Header = { type: 'header', version: 1, epoch: integer(raw.epoch, -1), known: raw.known.filter((id): id is string => typeof id === 'string').slice(-KNOWN),
        overhead: integer(raw.overhead, 0), softAt: typeof raw.softAt === 'number' && raw.softAt >= LEAD_CONTEXT.softShare && raw.softAt <= LEAD_CONTEXT.hardShare ? raw.softAt : LEAD_CONTEXT.softShare }
      if (header.epoch < 0) return null
      let turns: MessagesTurn[] = [], measured: RecordLine['measured'] = null
      for (const [index, line] of lines.slice(1).entries()) {
        if (!line.trim()) continue
        let value: Record<string, unknown>
        // Only the last line can be torn, by a crash during its write; it is the step the desk lost.
        try { value = JSON.parse(line) as Record<string, unknown> } catch { if (index === lines.length - 2) break; return null }
        if (value.type !== 'record') return null
        const record = this.#parseRecord(value)
        turns = this.#applied(turns, record)
        if (record.measured) measured = record.measured
      }
      return { header, turns, measured, bytes: Buffer.byteLength(text) }
    } catch { return null }
  }
  #parseRecord(value: Record<string, unknown>): RecordLine {
    const measured = value.measured && typeof value.measured === 'object' ? value.measured as Record<string, unknown> : null
    return { type: 'record', base: integer(value.base, 0), extend: textBlocks(value.extend), turns: parseLeadContextTurns(value.turns ?? []).turns,
      measured: measured ? { tokens: integer(measured.tokens, 0), bytes: integer(measured.bytes, 0) } : null }
  }
  /** A record lands after the stored turns: the turns it was built on and, when the desk stored something meanwhile,
   * that too. Its blocks for the last stored turn join that turn when it is a person or desk turn (never two turns of
   * one role in a row), and make a turn of their own after the Lead's; its base never moves it. */
  #applied(turns: readonly MessagesTurn[], record: Pick<RecordLine, 'base' | 'extend' | 'turns'>): MessagesTurn[] {
    return [...leadMergedTurns([...turns, ...(record.extend.length ? [{ role: 'user' as const, content: [...record.extend] }] : []), ...record.turns])]
  }
  #adopt(header: Header, turns: readonly MessagesTurn[], measured: RecordLine['measured']): void {
    this.#epoch = header.epoch; this.#known = [...header.known]; this.#overhead = header.overhead; this.#softAt = header.softAt
    this.#turns = turns; this.#measured = measured
    if (measured) this.#overhead = Math.max(0, measured.tokens - leadEstimatedTokens(measured.bytes))
  }
  /** No stored conversation for this epoch (a desk from before the context engine, or a file lost): start from the
   * words the person can read, which is what every request carried before. */
  async #seed(epoch: number): Promise<void> {
    const messages = this.options.journal.state.messages
    const turns = leadHistory(messages)
    this.#adopt({ type: 'header', version: 1, epoch, known: messages.filter(message => message.role === 'user').map(message => message.id), overhead: 0, softAt: LEAD_CONTEXT.softShare }, turns, null)
    await this.#snapshot(FILE)
  }
  #remember(ids: readonly string[]): void { this.#known = [...this.#known, ...ids].slice(-KNOWN) }
  #header(epoch = this.#epoch): Header {
    return { type: 'header', version: 1, epoch, known: this.#known.slice(-KNOWN), overhead: this.#overhead, softAt: this.#softAt }
  }
  /** The whole conversation as one record, written beside the file and moved over it. */
  async #snapshot(name: string, epoch = this.#epoch, turns = this.#turns): Promise<void> {
    turns = this.#bounded(leadMergedTurns(turns))
    if (name === FILE) this.#turns = turns
    const text = `${JSON.stringify(this.#header(epoch))}\n${JSON.stringify({ type: 'record', base: 0, extend: [], turns, measured: null } satisfies RecordLine)}\n`
    const temporary = this.#path(`${name}.tmp`)
    const handle = await open(temporary, 'w', 0o600)
    try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
    if (name === NEXT) { await rename(temporary, this.#path(NEXT)); return }
    await rename(temporary, this.#path(FILE))
    this.#fileBytes = Buffer.byteLength(text)
    this.#measured = null
  }
  /** Never more than the disk bound: older tool results trimmed first, then the oldest turns dropped at a person's
   * turn. Compaction runs long before this; it is the bound, not the policy. */
  #bounded(turns: readonly MessagesTurn[]): readonly MessagesTurn[] {
    const room = LEAD_CONTEXT.diskBytes - 65_536
    if (leadContextBytes(turns) <= room) return turns
    let kept = leadPruneContext(turns)
    while (leadContextBytes(kept) > room) {
      let cut = 1
      while (cut < kept.length && !leadContextBoundary(kept, cut)) cut++
      // No boundary left to cut at: keep from the last person or desk turn, its tool pairs whole.
      if (cut >= kept.length) { const from = kept.findLastIndex(turn => turn.role === 'user'); kept = leadPairedTurns(kept.slice(Math.max(0, from))); break }
      this.#remember(personIds(kept.slice(0, cut)))
      kept = kept.slice(cut)
    }
    return kept
  }

  /**
   * The person's section of a checkpoint over `region`: every person message the conversation took in up to the end of
   * the region (those earlier checkpoints already covered, then the region's own), quoted from the journal, which is the
   * only record of what the person said. Never read back from an earlier checkpoint's text, which the model wrote around.
   * A message the journal no longer holds is named by its reference.
   */
  #personSection(region: readonly MessagesTurn[], tail: readonly MessagesTurn[]): string {
    const later = new Set(personIds(tail)), ids = [...new Set([...this.#known, ...personIds(region)])].filter(id => !later.has(id))
    const recorded = new Map(this.options.journal.state.messages.flatMap(message => message.role === 'user' ? [[message.id, message.text] as const] : []))
    const covered = new Set(ids)
    const words = this.options.journal.state.messages.flatMap(message => message.role === 'user' && covered.has(message.id) ? [{ id: message.id, text: message.text }] : [])
    return leadPersonSection(words, ids.filter(id => !recorded.has(id)))
  }
  /** Person messages the stored conversation does not hold yet, oldest first, as the words a request carries. */
  #unstored(): MessagesTurn[] {
    const known = new Set([...this.#known, ...personIds(this.#turns)])
    return this.options.journal.state.messages.filter(message => message.role === 'user' && !known.has(message.id)).flatMap(message => leadHistory([message]).slice(-1))
  }
  /**
   * What the host's next request starts from: the stored conversation, then the person's words it does not hold yet.
   * The cache mark goes after the person's words (`stable`); the step records everything after `base`, so those
   * words are stored once the model has answered them, and sent again if it never did.
   */
  request(): Promise<{ readonly messages: MessagesTurn[]; readonly epoch: number; readonly persons: readonly string[]; readonly base?: LeadContextMark; readonly stable?: LeadContextMark }> {
    return this.#serial(async () => {
      if (!this.#turns.length) {
        const fresh = this.#unstored()
        if (fresh.length) await this.#append({ base: 0, extend: [], turns: fresh, measured: null })
      }
      const unstored = this.#unstored()
      const stored = [...leadPairedTurns(this.#turns)], messages = [...leadMergedTurns([...stored, ...unstored])]
      const base = leadContextMarkOf(stored), stable = leadContextMarkOf(messages)
      return { messages, epoch: this.#epoch, persons: personIds(unstored), ...(base ? { base } : {}), ...(stable ? { stable } : {}) }
    })
  }
  /**
   * After the host's request: person messages it carried that the step's record did not store (the record was lost)
   * but the Lead has answered are stored now, with the reply as the person reads it, so the next request never sends
   * them as new. Messages left unanswered stay unstored and go again.
   */
  settle(persons: readonly string[]): Promise<void> {
    return this.#serial(async () => {
      const known = new Set([...this.#known, ...personIds(this.#turns)])
      const messages = this.options.journal.state.messages, open = persons.filter(id => !known.has(id))
      const last = messages.findLastIndex(message => message.role === 'user' && open.includes(message.id))
      if (!open.length || last < 0) return
      const replies = messages.slice(last + 1).filter(message => message.role === 'assistant')
      if (!replies.length) return
      const turns = leadHistory([...messages.filter(message => message.role === 'user' && open.includes(message.id)), ...replies])
      await this.#append({ base: this.#turns.length, extend: [], turns, measured: null })
    })
  }
  /** One step's turns, from the child. Recorded against whatever epoch is current: a step cut across a compaction
   * still happened after the turns the checkpoint kept, so a record from an earlier epoch goes after them, its base
   * (a count in a conversation that no longer exists) never read. */
  record(input: LeadContextRecordInput): Promise<void> {
    return this.#serial(async () => {
      // The provider's count for the step's last request, against the bytes of the messages that request carried:
      // what is left over is the instructions, tools and framing every request carries.
      const tokens = input.usage ? input.usage.input + input.usage.cacheRead + input.usage.cacheWrite : null
      const bytes = input.usage?.bytes ?? leadContextBytes(this.#turns)
      if (tokens !== null) this.#overhead = Math.max(0, tokens - leadEstimatedTokens(bytes))
      const base = input.epoch === this.#epoch ? input.base : this.#turns.length
      await this.#append({ base, extend: input.extend, turns: input.turns, measured: tokens === null ? null : { tokens, bytes } })
    })
  }
  async #append(record: Omit<RecordLine, 'type'>): Promise<void> {
    record = { ...record, turns: leadMergedTurns(record.turns) }
    this.#turns = this.#applied(this.#turns, record)
    if (record.measured) this.#measured = record.measured
    const line = `${JSON.stringify({ type: 'record', ...record } satisfies RecordLine)}\n`
    if (this.#fileBytes + Buffer.byteLength(line) > LEAD_CONTEXT.diskBytes) { const measured = this.#measured; await this.#snapshot(FILE); this.#measured = measured; return }
    await appendFile(this.#path(FILE), line, { mode: 0o600 })
    this.#fileBytes += Buffer.byteLength(line)
  }
  /** The stored conversation for a child whose copy is from another epoch; null when its copy is current. */
  read(epoch: number, room = READ_BYTES): Promise<{ readonly epoch: number; readonly messages: readonly MessagesTurn[] } | null> {
    return this.#serial(async () => {
      if (epoch === this.#epoch || !this.#turns.length) return null
      // One frame carries it: past that, the checkpoint and the latest turns that fit; none fitting waits for the
      // host's own next request.
      const messages = leadFitTurns(leadPairedTurns(this.#turns), Math.min(READ_BYTES, room))
      return messages === null ? null : { epoch: this.#epoch, messages: [...messages] }
    })
  }

  /** Tokens the next request would carry: the last count the provider gave, plus an estimate for what came after. */
  tokens(turns = this.#turns): number {
    return this.#overhead + leadEstimatedTokens(leadContextBytes(turns))
  }
  pressure(): number {
    return leadContextPressure({ window: this.window, tokens: this.tokens(), bytes: leadContextBytes(this.#turns), turns: this.#turns.length })
  }
  /** Which compaction is due now, if any: hard before the next request whatever is happening, soft only when idle. */
  due(): Extract<LeadCompactionTrigger, 'soft' | 'hard'> | null {
    const pressure = this.pressure()
    if (this.#fullAt !== null) {
      if (pressure < this.#fullAt + LEAD_CONTEXT.hysteresis) return null
      this.#fullAt = null
    }
    return pressure >= LEAD_CONTEXT.hardShare ? 'hard' : pressure >= this.#softAt ? 'soft' : null
  }

  /**
   * One compaction. The pruning stage first, which needs no model; then, when that is not enough (or the person
   * asked), a checkpoint of the region before the kept tail, written by the model from the very prefix it has been
   * reading, checked, and retried twice; after three failures, or while the breaker is open, written by the desk.
   */
  async compact(trigger: LeadCompactionTrigger, send: LeadContextSend): Promise<LeadCompactionOutcome> {
    if (this.#compacting || this.options.journal.state.context.pending) return 'busy'
    this.#compacting = true
    try { return await this.#compact(trigger, send) }
    finally { this.#compacting = false }
  }
  get compacting(): boolean { return this.#compacting }
  async #compact(trigger: LeadCompactionTrigger, send: LeadContextSend): Promise<LeadCompactionOutcome> {
    const { journal, now, nextId } = this.options
    const id = nextId(), beforeTokens = this.tokens()
    const pruned = leadPruneContext(this.#turns)
    let split = leadContextSplit(this.#turns, this.window)
    if (pruned === this.#turns && split === null) { this.#softAt = Math.min(LEAD_CONTEXT.hardShare, this.pressure() + LEAD_CONTEXT.hysteresis); return 'nothing' }
    const share = (turns: readonly MessagesTurn[]) => leadContextPressure({ window: this.window, tokens: this.tokens(turns), bytes: leadContextBytes(turns), turns: turns.length })
    // A kept tail that stays past the hard line by itself would bring the next compaction straight back: keep the
    // smallest tail instead, its older tool results trimmed too.
    const room = leadCheckpointTurn(id, 'x'.repeat(LEAD_CONTEXT.checkpointChars), true)
    let smallest = false
    if (split !== null && share([room, ...leadPruneContext(this.#turns.slice(split))]) >= LEAD_CONTEXT.hardShare) {
      const fewer = leadContextSplit(this.#turns, this.window, true)
      if (fewer !== null) { split = fewer; smallest = true }
    }
    await journal.contextCompactionStarted(id, now(), trigger)
    try {
      if (pruned !== this.#turns) {
        if (split === null || trigger !== 'manual' && share(pruned) < this.#softAt) {
          const afterTokens = this.tokens(pruned)
          await this.#replace(id, current => leadPruneContext(current), () => journal.contextPruned({ id, at: now(), beforeTokens, afterTokens }), share(pruned))
          return 'pruned'
        }
      }
      if (split === null) { await journal.contextCompactionFailed(id, 'blocked'); return 'nothing' }
      const from = split
      const region = [...leadPairedTurns(this.#turns.slice(0, from))]
      const previous = leadCheckpointText(region[0])
      let requiredIds: readonly string[] = []
      try { requiredIds = await this.#connections.ledgerIds?.() ?? [] } catch { /* A checkpoint without the ledger's ids still stands. */ }
      const regionBytes = leadContextBytes(region)
      // The person's words come from the desk, never from the model: only a message the desk recorded as theirs.
      const person = this.#personSection(region, this.#turns.slice(from))
      const attempts = journal.state.context.failures >= LEAD_CONTEXT.breaker ? 1 : LEAD_CONTEXT.attempts
      let text: string | null = null, usdMicros = 0
      for (let attempt = 0; attempt < attempts && text === null; attempt++) {
        const spent = journal.state.budget?.leadUsdMicros ?? 0
        let reason: string
        try {
          const result = await send({ messages: leadCheckpointMessages(region, leadCheckpointInstruction({ merging: previous !== null, requiredIds })),
            maxTokens: LEAD_CONTEXT.checkpointTokens, compaction: true, epoch: this.#epoch, ...(leadContextMarkOf(region) ? { stable: leadContextMarkOf(region)! } : {}) })
          usdMicros += Math.max(0, (journal.state.budget?.leadUsdMicros ?? 0) - spent)
          // Refused (the budget, a stop) or cut short is not the model failing to write: the run ends, uncounted.
          if (result.status === 'refused' || result.status === 'cancelled' || result.status === 'rate-limited') {
            await journal.contextCompactionFailed(id, 'blocked')
            return 'stopped'
          }
          const written = result.status === 'completed' ? result.text?.trim() ?? '' : null
          const composed = written ? leadCheckpointCompose(person, written) : null
          reason = written === null ? (/^[a-z-]{1,64}$/.test(result.reason ?? '') ? result.reason! : result.status) : leadCheckpointRefusal(written, { regionBytes, requiredIds, ...(composed ? { composed } : {}) }) ?? ''
          if (composed !== null && !reason) text = composed
          // The provider refused the desk's own key, configuration or request: no attempt of the model's will do better.
          if (written === null && LEAD_CONTEXT_UNCOUNTED.includes(reason)) {
            await journal.contextCompactionFailed(id, reason)
            return 'stopped'
          }
        } catch {
          // The host could not reach the Lead (or the reply did not pass the screen): not the model's failure either.
          await journal.contextCompactionFailed(id, 'unreachable')
          return 'stopped'
        }
        if (text === null) await journal.contextCompactionFailed(id, reason.slice(0, 64))
      }
      const fallback = text === null
      text ??= leadFallbackCheckpoint({ region, previous, ledgerIds: requiredIds, person })
      const checkpoint = leadCheckpointTurn(id, text, fallback)
      const tailOf = (current: readonly MessagesTurn[]) => smallest ? leadPruneContext(current.slice(from), 0) : current.slice(from)
      const after = [checkpoint, ...tailOf(this.#turns)]
      const afterTokens = this.tokens(after), afterShare = share(after)
      const revisions = personIds(region).flatMap(person => journal.state.messages.find(message => message.id === person)?.revision ?? [])
      const fromSeq = revisions.length ? Math.min(...revisions) : 0, toSeq = revisions.length ? Math.max(...revisions) : fromSeq
      this.#remember(personIds(region))
      await this.#replace(id, current => [checkpoint, ...tailOf(current)], () => journal.contextCompactionApplied({ id, at: now(), fromSeq, toSeq, beforeTokens, afterTokens,
        model: this.options.model, usdMicros, fallback }), afterShare)
      // Still past the hard line with the smallest tail: stop compacting until it grows by the hysteresis, and say so.
      this.#fullAt = afterShare >= LEAD_CONTEXT.hardShare ? afterShare : null
      // Shown only once it passes the same screen a reply does; the conversation keeps it either way.
      let shown: string | null = text.slice(0, 32_768)
      try { await this.#connections.screen?.(shown) } catch { shown = null }
      this.#checkpoints = [...this.#checkpoints, { id, at: now(), fallback, beforeTokens, afterTokens, text: shown }].slice(-CHECKPOINT_LIST)
      await writeAtomicJson(this.#path(CHECKPOINTS), { version: 1, checkpoints: this.#checkpoints }, async () => {}).catch(() => {})
      return 'applied'
    } catch (error) {
      if (journal.state.context.pending?.id === id) await journal.contextCompactionFailed(id, 'interrupted').catch(() => {})
      throw error
    }
  }
  /**
   * The two-phase swap: the new conversation is written beside the old, the journal records the new epoch, then it
   * is moved into place. `build` makes it from the conversation as it stands then, so turns recorded while the model
   * was writing follow the tail they came after.
   */
  async #replace(id: string, build: (current: readonly MessagesTurn[]) => readonly MessagesTurn[], commit: () => Promise<void>, share: number): Promise<void> {
    await this.#serial(async () => {
      const turns = leadMergedTurns(build(this.#turns))
      const epoch = this.#epoch + 1
      this.#softAt = leadNextSoftShare(share)
      await this.#snapshot(NEXT, epoch, turns)
      await commit()
      if (this.options.journal.state.context.epoch !== epoch) throw new Error(`lead-context-epoch-${id}`)
      this.#epoch = epoch
      this.#turns = turns
      await rename(this.#path(NEXT), this.#path(FILE))
      this.#fileBytes = Buffer.byteLength(await readFile(this.#path(FILE), 'utf8'))
      this.#measured = null
    })
  }

  facts(): LeadContextFacts {
    const wakes = this.options.journal.state.wakes.flatMap(wake => wake.tokens ? [wake.tokens] : [])
    const total = wakes.reduce((sum, tokens) => sum + tokens.input + tokens.cacheRead + tokens.cacheWrite, 0)
    return parseLeadContextFacts({ version: 1, windowTokens: this.window, usedTokens: this.#turns.length ? Math.min(100_000_000, Math.round(this.tokens())) : null,
      cacheHitRate: total ? wakes.reduce((sum, tokens) => sum + tokens.cacheRead, 0) / total : null, compacting: this.#compacting, checkpoints: this.#checkpoints,
      ...(this.#fullAt !== null ? { full: true } : {}) })
  }
}
