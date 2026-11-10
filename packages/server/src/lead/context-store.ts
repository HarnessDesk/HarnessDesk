import { appendFile, lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LEAD_CONTEXT, leadCheckpointInstruction, leadCheckpointMessages, leadCheckpointRefusal, leadCheckpointText, leadCheckpointTurn,
  leadContextBoundary, leadContextBytes, leadContextMarkOf, leadContextPressure, leadContextSplit, leadContextWindow, leadEstimatedTokens,
  leadFallbackCheckpoint, leadHistory, leadNextSoftShare, leadPairedTurns, leadPruneContext, parseLeadContextTurns,
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
  /** Work ids every checkpoint must name (the work ledger); none until it exists. */
  readonly ledgerIds?: () => readonly string[]
  /** Test seam: a smaller window than the model's. */
  readonly window?: number
}
export type LeadContextSend = (input: LeadMessagesRequest) => Promise<LeadMessagesResult>
export type LeadCompactionOutcome = 'applied' | 'pruned' | 'nothing' | 'busy'

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
  #fileBytes = 0
  #tail: Promise<unknown> = Promise.resolve()
  private constructor(private readonly options: LeadContextStoreOptions) {}

  static async open(options: LeadContextStoreOptions): Promise<LeadContextStore> {
    const store = new LeadContextStore(options)
    await store.#open()
    return store
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
      try { this.#checkpoints = [...parseLeadContextFacts({ version: 1, windowTokens: 1, usedTokens: null, cacheHitRate: null, compacting: false, checkpoints: kept.checkpoints.slice(0, CHECKPOINT_LIST) }).checkpoints] }
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
  /** A record lands after the turns it was built on; when the desk stored something meanwhile, after that too. */
  #applied(turns: readonly MessagesTurn[], record: Pick<RecordLine, 'base' | 'extend' | 'turns'>): MessagesTurn[] {
    const last = turns.at(-1)
    if (record.base === turns.length && last?.role === 'user' && record.extend.length)
      return [...turns.slice(0, -1), { role: 'user', content: [...last.content, ...record.extend] }, ...record.turns]
    return [...turns, ...(record.extend.length ? [{ role: 'user' as const, content: [...record.extend] }] : []), ...record.turns]
  }
  #adopt(header: Header, turns: readonly MessagesTurn[], measured: RecordLine['measured']): void {
    this.#epoch = header.epoch; this.#known = [...header.known]; this.#overhead = header.overhead; this.#softAt = header.softAt
    this.#turns = turns; this.#measured = measured
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
    turns = this.#bounded(turns)
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
      if (cut >= kept.length) { kept = kept.slice(-1); break }
      this.#remember(personIds(kept.slice(0, cut)))
      kept = kept.slice(cut)
    }
    return kept
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
  request(): Promise<{ readonly messages: MessagesTurn[]; readonly epoch: number; readonly base?: LeadContextMark; readonly stable?: LeadContextMark }> {
    return this.#serial(async () => {
      if (!this.#turns.length) {
        const fresh = this.#unstored()
        if (fresh.length) await this.#append({ base: 0, extend: [], turns: fresh, measured: null })
      }
      const stored = [...leadPairedTurns(this.#turns)], messages = [...stored, ...this.#unstored()]
      const base = leadContextMarkOf(stored), stable = leadContextMarkOf(messages)
      return { messages, epoch: this.#epoch, ...(base ? { base } : {}), ...(stable ? { stable } : {}) }
    })
  }
  /** One step's turns, from the child. Recorded against whatever epoch is current: a step cut across a compaction
   * still happened after the turns the checkpoint kept. */
  record(input: LeadContextRecordInput): Promise<void> {
    return this.#serial(async () => {
      const bytes = leadContextBytes(this.#turns)
      const tokens = input.usage ? input.usage.input + input.usage.cacheRead + input.usage.cacheWrite : null
      if (tokens !== null) this.#overhead = Math.max(0, tokens - leadEstimatedTokens(bytes))
      await this.#append({ base: input.base, extend: input.extend, turns: input.turns, measured: tokens === null ? null : { tokens, bytes } })
    })
  }
  async #append(record: Omit<RecordLine, 'type'>): Promise<void> {
    this.#turns = this.#applied(this.#turns, record)
    if (record.measured) this.#measured = record.measured
    const line = `${JSON.stringify({ type: 'record', ...record } satisfies RecordLine)}\n`
    if (this.#fileBytes + Buffer.byteLength(line) > LEAD_CONTEXT.diskBytes) { const measured = this.#measured; await this.#snapshot(FILE); this.#measured = measured; return }
    await appendFile(this.#path(FILE), line, { mode: 0o600 })
    this.#fileBytes += Buffer.byteLength(line)
  }
  /** The stored conversation for a child whose copy is from another epoch; null when its copy is current. */
  read(epoch: number): Promise<{ readonly epoch: number; readonly messages: readonly MessagesTurn[] } | null> {
    return this.#serial(async () => {
      if (epoch === this.#epoch || !this.#turns.length) return null
      const messages = leadPairedTurns(this.#turns)
      // One frame carries it; a conversation past that waits for the host's own next request.
      return leadContextBytes(messages) > READ_BYTES ? null : { epoch: this.#epoch, messages: [...messages] }
    })
  }

  /** Tokens the next request would carry: the last count the provider gave, plus an estimate for what came after. */
  tokens(turns = this.#turns): number {
    const bytes = leadContextBytes(turns)
    return this.#measured && turns === this.#turns ? this.#measured.tokens + leadEstimatedTokens(Math.max(0, bytes - this.#measured.bytes))
      : this.#overhead + leadEstimatedTokens(bytes)
  }
  pressure(): number {
    return leadContextPressure({ window: this.window, tokens: this.tokens(), bytes: leadContextBytes(this.#turns), turns: this.#turns.length })
  }
  /** Which compaction is due now, if any: hard before the next request whatever is happening, soft only when idle. */
  due(): Extract<LeadCompactionTrigger, 'soft' | 'hard'> | null {
    const pressure = this.pressure()
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
    const split = leadContextSplit(this.#turns, this.window)
    if (pruned === this.#turns && split === null) { this.#softAt = Math.min(LEAD_CONTEXT.hardShare, this.pressure() + LEAD_CONTEXT.hysteresis); return 'nothing' }
    await journal.contextCompactionStarted(id, now(), trigger)
    try {
      if (pruned !== this.#turns) {
        const share = leadContextPressure({ window: this.window, tokens: this.tokens(pruned), bytes: leadContextBytes(pruned), turns: pruned.length })
        if (split === null || trigger !== 'manual' && share < this.#softAt) {
          const afterTokens = this.tokens(pruned)
          await this.#replace(id, pruned, pruned.length, () => journal.contextPruned({ id, at: now(), beforeTokens, afterTokens }), share)
          return 'pruned'
        }
      }
      if (split === null) return 'nothing'
      const region = [...leadPairedTurns(this.#turns.slice(0, split))]
      const previous = leadCheckpointText(region[0])
      const requiredIds = this.options.ledgerIds?.() ?? []
      const regionBytes = leadContextBytes(region)
      const attempts = journal.state.context.failures >= LEAD_CONTEXT.breaker ? 1 : LEAD_CONTEXT.attempts
      let text: string | null = null, usdMicros = 0
      for (let attempt = 0; attempt < attempts && text === null; attempt++) {
        const spent = journal.state.budget?.leadUsdMicros ?? 0
        let reason: string
        try {
          const result = await send({ messages: leadCheckpointMessages(region, leadCheckpointInstruction({ merging: previous !== null, requiredIds })),
            maxTokens: LEAD_CONTEXT.checkpointTokens, compaction: true, epoch: this.#epoch, ...(leadContextMarkOf(region) ? { stable: leadContextMarkOf(region)! } : {}) })
          const written = result.status === 'completed' ? result.text?.trim() ?? '' : null
          reason = written === null ? (/^[a-z-]{1,64}$/.test(result.reason ?? '') ? result.reason! : result.status) : leadCheckpointRefusal(written, { regionBytes, requiredIds }) ?? ''
          if (written !== null && !reason) text = written
        } catch { reason = 'request-failed' }
        usdMicros += Math.max(0, (journal.state.budget?.leadUsdMicros ?? 0) - spent)
        if (text === null) await journal.contextCompactionFailed(id, reason.slice(0, 64))
      }
      const fallback = text === null
      text ??= leadFallbackCheckpoint({ region, previous, ledgerIds: requiredIds })
      const checkpoint = leadCheckpointTurn(id, text, fallback)
      const tail = this.#turns.slice(split)
      const afterTokens = this.#overhead + leadEstimatedTokens(leadContextBytes([checkpoint, ...tail]))
      const revisions = personIds(region).flatMap(person => journal.state.messages.find(message => message.id === person)?.revision ?? [])
      const fromSeq = revisions.length ? Math.min(...revisions) : 0, toSeq = revisions.length ? Math.max(...revisions) : fromSeq
      this.#remember(personIds(region))
      await this.#replace(id, [checkpoint], split, () => journal.contextCompactionApplied({ id, at: now(), fromSeq, toSeq, beforeTokens, afterTokens,
        model: this.options.model, usdMicros, fallback }), afterTokens / this.window)
      this.#checkpoints = [{ id, at: now(), fallback, beforeTokens, afterTokens, text: text.slice(0, 32_768) }, ...this.#checkpoints].slice(0, CHECKPOINT_LIST)
      await writeAtomicJson(this.#path(CHECKPOINTS), { version: 1, checkpoints: this.#checkpoints }, async () => {}).catch(() => {})
      return 'applied'
    } catch (error) {
      if (journal.state.context.pending?.id === id) await journal.contextCompactionFailed(id, 'interrupted').catch(() => {})
      throw error
    }
  }
  /**
   * The two-phase swap: the new conversation is written beside the old, the journal records the new epoch, then it
   * is moved into place. Turns recorded while the model was writing follow the tail they came after.
   */
  async #replace(id: string, head: readonly MessagesTurn[], from: number, commit: () => Promise<void>, share: number): Promise<void> {
    await this.#serial(async () => {
      const turns = [...head, ...this.#turns.slice(from)]
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
      cacheHitRate: total ? wakes.reduce((sum, tokens) => sum + tokens.cacheRead, 0) / total : null, compacting: this.#compacting, checkpoints: this.#checkpoints })
  }
}
