import { appendFile, lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LEAD_CONTEXT, leadCheckpointInstruction, leadCheckpointMessages, leadCheckpointRefusal, leadCheckpointText, leadCheckpointTurn,
  leadContextBoundary, leadContextBytes, leadContextMarkOf, leadContextPressure, leadContextSplit, leadContextWindow, leadEstimatedTokens,
  leadCheckpointCompose, leadFallbackCheckpoint, leadFitTurns, leadHistory, leadMergedTurns, leadNextSoftShare, leadPairedTurns, leadPersonSection, leadPersonQuotes, leadCheckpointModelPart,
  leadPruneAndFold, parseLeadContextTurns, LEAD_CONTEXT_UNCOUNTED, leadContainsSecret, LEAD_WITHHELD_TEXT, leadWithholdCredentialsReport, leadCredentialScreenViews,
  type LeadCompactionTrigger, type LeadContextMark, type LeadContextRecordInput, type LeadJournal, type LeadMessagesRequest,
  type LeadMessagesResult, type MessagesText, type MessagesTurn, leadClip, LEAD_WAKE_REFERENCE
} from '@harnessdesk/lead'
import { parseLeadContextFacts, type LeadCheckpointPerson, type LeadContextCheckpoint, type LeadContextFacts, type LeadMessage } from '@harnessdesk/protocol'
import { readBoundedJson, readBoundedJsonResult, writeAtomicJson } from './bounded-json.js'

/**
 * The Lead's stored conversation, owned by the host: provider-shaped turns with their tool pairs, the desk context
 * of each moment left as a one-line stub, and no reasoning. The child records what each step adds and reads it back
 * after a compaction; the host builds each of its own requests from it. It lives in `<home>/lead/context.jsonl`, is
 * never larger than `LEAD_CONTEXT.diskBytes`, and is replaced only through the journal (`context-compaction-*`), so a
 * crash at any point leaves either the old conversation or the new one, never a mix.
 */
/** The summaries the facts can carry, each checked alone: one entry the wire would refuse (a stored file from an older
 * desk, a field cut badly) drops itself, never the list, so reading the context and Summarise now keep working. */
const readableCheckpoints = (list: readonly unknown[]): LeadContextCheckpoint[] => list.flatMap(one => {
  try { return [...parseLeadContextFacts({ version: 1, windowTokens: 1, usedTokens: null, cacheHitRate: null, compacting: false, checkpoints: [one] }).checkpoints] }
  catch { return [] }
})
const FILE = 'context.jsonl', NEXT = 'context.next.jsonl', CHECKPOINTS = 'context-checkpoints.json', CHECKPOINT_STAGE = 'context-checkpoints.next.json'
const PERSON_REFERENCE = 'Desk reference for the preceding person message: '
const KNOWN = 1024, CHECKPOINT_LIST = 8, READ_BYTES = 1_000_000

interface CheckpointStage {
  readonly version: 1
  readonly id: string
  readonly epoch: number
  readonly count: number
  readonly checkpoints: readonly LeadContextCheckpoint[]
}

/** Recovery data is authority: reject the whole stage rather than dropping a bad entry. */
const checkpointStageOf = (value: unknown): CheckpointStage => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('lead-context-checkpoint-stage')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).sort().join(',') !== 'checkpoints,count,epoch,id,version' || raw.version !== 1 ||
    typeof raw.id !== 'string' || !raw.id || raw.id.length > 128 || !Number.isSafeInteger(raw.epoch) || (raw.epoch as number) < 1 ||
    !Number.isSafeInteger(raw.count) || (raw.count as number) < 0 || !Array.isArray(raw.checkpoints) ||
    raw.checkpoints.length < 1 || raw.checkpoints.length > CHECKPOINT_LIST) throw new Error('lead-context-checkpoint-stage')
  const checkpoints = parseLeadContextFacts({ version: 1, windowTokens: 1, usedTokens: null, cacheHitRate: null,
    compacting: false, checkpoints: raw.checkpoints }).checkpoints
  if (checkpoints.at(-1)?.id !== raw.id || (raw.count as number) < checkpoints.length) throw new Error('lead-context-checkpoint-stage')
  return { version: 1, id: raw.id, epoch: raw.epoch as number, count: raw.count as number, checkpoints }
}

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
  /** The desk as it stands now (the clock and the current work cards), read for each checkpoint so it never keeps a stale fact. */
  readonly deskNow?: () => Promise<string | null>
}

const referenced = (prefixes: readonly string[]) => (turns: readonly MessagesTurn[]): string[] => turns.flatMap(turn => turn.role !== 'user' ? [] : turn.content.flatMap(block => {
  const prefix = block.type === 'text' ? prefixes.find(one => block.text.startsWith(one)) : undefined
  return prefix !== undefined && block.type === 'text' ? [block.text.slice(prefix.length).trim()] : []
}))
/** Journal messages the stored turns hold: the person's own, and the desk's wakes. A wake is stored and sent once like a
 * person message, but it is never quoted as the person's words. */
const personIds = referenced([PERSON_REFERENCE, LEAD_WAKE_REFERENCE])
/** Only the person's own messages: what a checkpoint quotes as theirs. */
const spokenIds = referenced([PERSON_REFERENCE])
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
  /** Current-format views require screening of the complete displayed prose. */
  #checkpointScreening = false
  /** A current-format view is hidden until its latest screen completes. */
  #viewScreenPending = false
  /** Every summary applied, where `#checkpoints` keeps the latest eight: what Settings counts, as the thread marks them. */
  #count = 0
  #compacting = false
  /** Pressure after a compaction that could not bring the conversation under the hard line; no compaction is due
   * again until it rises past this by the hysteresis. */
  #fullAt: number | null = null
  #connections: LeadContextConnections = {}
  #fileBytes = 0
  #needsRecovery = false
  /** The conversation committed, but its separate checkpoint view still needs a durable copy. */
  #checkpointPending = false
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
    if (this.#checkpointPending || this.#checkpointScreening) this.#viewScreenPending = true
    // Checkpoints kept from before the screen was wired pass it too before they are shown.
    return this.#serial(async () => {
      const previous = this.#checkpoints
      const complete = this.#checkpointPending || this.#checkpointScreening
      const next = await Promise.all(previous.map(async checkpoint => {
        const parts = [...(complete ? checkpoint.person?.messages.map(message => message.text) ?? [] : []),
          ...(checkpoint.text === null ? [] : [checkpoint.text])]
        if (!parts.length) return checkpoint
        try { await screen(parts.join('\n')); return checkpoint } catch (error) {
          if (!complete) return { ...checkpoint, text: null }
          if ((error as { wireCode?: unknown })?.wireCode !== 'lead-secret-refused') throw error
          const { person: _person, ...withheld } = checkpoint
          return { ...withheld, text: null }
        }
      }))
      if (complete && screen !== this.#connections.screen) throw Object.assign(new Error('lead-protection-unavailable'), { wireCode: 'lead-protection-unavailable' })
      if (complete && JSON.stringify(previous) !== JSON.stringify(next)) {
        // Do not acknowledge a newly withheld view while an older staged copy
        // could be promoted after restart. An uncertain rewrite needs replay.
        this.#checkpoints = next
        this.#needsRecovery = true
        if (this.#checkpointPending) await this.#persistWithheldCheckpointView(previous, next)
        else await this.#persistCurrentCheckpointView(previous, next)
        this.#needsRecovery = false
      } else this.#checkpoints = next
      if (complete) {
        if (screen !== this.#connections.screen) throw Object.assign(new Error('lead-protection-unavailable'), { wireCode: 'lead-protection-unavailable' })
        this.#viewScreenPending = false
      }
    })
  }
  get epoch(): number { return this.#epoch }
  get window(): number { return this.options.window ?? leadContextWindow(this.options.model) }
  /** The stored turns, for tests and the checkpoint view. */
  get turns(): readonly MessagesTurn[] { return this.#turns }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(() => {
      if (this.#needsRecovery) throw new Error('lead-context-recovery-required')
      return work()
    })
    this.#tail = next.catch(() => {})
    return next
  }
  #path(name: string) { return join(this.options.directory, name) }

  async #persistCurrentCheckpointView(previous: readonly LeadContextCheckpoint[], next: readonly LeadContextCheckpoint[]): Promise<void> {
    const canonical = await readBoundedJsonResult(this.#path(CHECKPOINTS), 600_000), context = this.options.journal.state.context
    if (canonical.kind !== 'value' || !canonical.value || typeof canonical.value !== 'object' ||
        (canonical.value as { version?: unknown }).version !== 1 || (canonical.value as { screeningVersion?: unknown }).screeningVersion !== 1 ||
        (canonical.value as { count?: unknown }).count !== this.#count ||
        JSON.stringify((canonical.value as { checkpoints?: unknown }).checkpoints) !== JSON.stringify(previous))
      throw new Error('lead-context-recovery-required')
    await writeAtomicJson(this.#path(CHECKPOINTS), { version: 1, screeningVersion: 1, count: this.#count, checkpoints: next }, async () => {
      const again = await readBoundedJsonResult(this.#path(CHECKPOINTS), 600_000)
      const stage = await readBoundedJsonResult(this.#path(CHECKPOINT_STAGE), 600_000)
      const current = this.options.journal.state.context
      if (stage.kind !== 'missing' || again.kind !== 'value' || JSON.stringify(again.value) !== JSON.stringify(canonical.value) ||
          current.epoch !== context.epoch || current.last?.id !== context.last?.id) throw new Error('lead-context-recovery-required')
    })
  }

  async #removeCheckpointStage(): Promise<void> {
    await rm(this.#path(CHECKPOINT_STAGE), { force: true })
    const directory = await open(this.options.directory, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }

  async #persistWithheldCheckpointView(previous: readonly LeadContextCheckpoint[], next: readonly LeadContextCheckpoint[]): Promise<void> {
    const read = await readBoundedJsonResult(this.#path(CHECKPOINT_STAGE), 600_000), context = this.options.journal.state.context
    if (read.kind === 'value') {
      const stage = checkpointStageOf(read.value)
      if (stage.epoch !== context.epoch || stage.id !== context.last?.id || stage.count !== this.#count ||
          JSON.stringify(stage.checkpoints) !== JSON.stringify(previous)) throw new Error('lead-context-recovery-required')
      const withheld = checkpointStageOf({ ...stage, checkpoints: next })
      await writeAtomicJson(this.#path(CHECKPOINT_STAGE), withheld, async () => {
        const again = await readBoundedJsonResult(this.#path(CHECKPOINT_STAGE), 600_000)
        const current = this.options.journal.state.context
        if (again.kind !== 'value' || JSON.stringify(again.value) !== JSON.stringify(read.value) ||
            current.epoch !== stage.epoch || current.last?.id !== stage.id) throw new Error('lead-context-recovery-required')
      })
      return
    }
    if (read.kind !== 'missing') throw new Error('lead-context-recovery-required')
    const canonical = await readBoundedJsonResult(this.#path(CHECKPOINTS), 600_000)
    if (canonical.kind !== 'value' || !canonical.value || typeof canonical.value !== 'object' ||
        (canonical.value as { version?: unknown }).version !== 1 || (canonical.value as { screeningVersion?: unknown }).screeningVersion !== 1 ||
        (canonical.value as { count?: unknown }).count !== this.#count ||
        JSON.stringify((canonical.value as { checkpoints?: unknown }).checkpoints) !== JSON.stringify(previous))
      throw new Error('lead-context-recovery-required')
    await writeAtomicJson(this.#path(CHECKPOINTS), { version: 1, screeningVersion: 1, count: this.#count, checkpoints: next }, async () => {
      const stage = await readBoundedJsonResult(this.#path(CHECKPOINT_STAGE), 600_000)
      const again = await readBoundedJsonResult(this.#path(CHECKPOINTS), 600_000)
      const current = this.options.journal.state.context
      if (stage.kind !== 'missing' || again.kind !== 'value' || JSON.stringify(again.value) !== JSON.stringify(canonical.value) ||
          current.epoch !== context.epoch || current.last?.id !== context.last?.id) throw new Error('lead-context-recovery-required')
    })
    this.#checkpointPending = false
  }

  /** Finish only the same still-authorized view; never restore a view a later screen withheld. */
  async #finishCheckpointView(): Promise<void> {
    const read = await readBoundedJsonResult(this.#path(CHECKPOINT_STAGE), 600_000)
    const context = this.options.journal.state.context
    // If unlink succeeded but its directory sync failed, the already-durable
    // canonical view can establish the same authority without recreating it.
    const missing = read.kind === 'missing'
    if (read.kind !== 'value' && !missing) throw new Error('lead-context-recovery-required')
    const stage = checkpointStageOf(missing ? { version: 1, id: context.last?.id, epoch: context.epoch,
      count: this.#count, checkpoints: this.#checkpoints } : read.value)
    if (stage.epoch !== context.epoch || stage.id !== context.last?.id || stage.count !== this.#count ||
        JSON.stringify(stage.checkpoints) !== JSON.stringify(this.#checkpoints)) throw new Error('lead-context-recovery-required')
    if (missing) {
      const canonical = await readBoundedJsonResult(this.#path(CHECKPOINTS), 600_000)
      if (canonical.kind !== 'value' || !canonical.value || typeof canonical.value !== 'object' ||
          (canonical.value as { version?: unknown }).version !== 1 || (canonical.value as { screeningVersion?: unknown }).screeningVersion !== 1 ||
          (canonical.value as { count?: unknown }).count !== stage.count ||
          JSON.stringify((canonical.value as { checkpoints?: unknown }).checkpoints) !== JSON.stringify(stage.checkpoints))
        throw new Error('lead-context-recovery-required')
    }
    const screen = this.#connections.screen
    const prose = stage.checkpoints.flatMap(checkpoint => {
      const parts = [...(checkpoint.person?.messages.map(message => message.text) ?? []),
        ...(checkpoint.text === null ? [] : [checkpoint.text])]
      return parts.length ? [parts.join('\n')] : []
    })
    if (prose.length && !screen) throw new Error('lead-context-recovery-required')
    try { for (const entry of prose) await screen!(entry) } catch { throw new Error('lead-context-recovery-required') }
    if (screen !== this.#connections.screen) throw new Error('lead-context-recovery-required')
    if (missing) {
      const directory = await open(this.options.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
      if (screen !== this.#connections.screen || JSON.stringify(stage.checkpoints) !== JSON.stringify(this.#checkpoints))
        throw new Error('lead-context-recovery-required')
      this.#checkpointPending = false
      return
    }
    await writeAtomicJson(this.#path(CHECKPOINTS), { version: 1, screeningVersion: 1, count: stage.count, checkpoints: stage.checkpoints }, async () => {
      if (screen !== this.#connections.screen || JSON.stringify(stage.checkpoints) !== JSON.stringify(this.#checkpoints))
        throw new Error('lead-context-recovery-required')
    })
    if (screen !== this.#connections.screen || JSON.stringify(stage.checkpoints) !== JSON.stringify(this.#checkpoints))
      throw new Error('lead-context-recovery-required')
    await this.#removeCheckpointStage()
    this.#checkpointPending = false
  }

  async #recoverCheckpointStage(): Promise<void> {
    const read = await readBoundedJsonResult(this.#path(CHECKPOINT_STAGE), 600_000)
    if (read.kind === 'missing') return
    if (read.kind !== 'value') throw new Error('lead-context-checkpoint-recovery')
    const stage = checkpointStageOf(read.value), context = this.options.journal.state.context
    if (stage.epoch === context.epoch && context.last?.id === stage.id) {
      // Keep the stage until the canonical file and its directory are durable.
      await writeAtomicJson(this.#path(CHECKPOINTS), { version: 1, screeningVersion: 1, count: stage.count, checkpoints: stage.checkpoints }, async () => {})
      await this.#removeCheckpointStage()
      return
    }
    if (stage.epoch === context.epoch + 1 && context.pending?.id === stage.id) {
      await this.#removeCheckpointStage()
      return
    }
    throw new Error('lead-context-checkpoint-recovery')
  }

  async #open(): Promise<void> {
    const { journal } = this.options
    // A newer canonical format is never overwritten by otherwise valid recovery.
    const original = await readBoundedJsonResult(this.#path(CHECKPOINTS), 600_000)
    if (original.kind === 'value' && original.value && typeof original.value === 'object' &&
        Object.hasOwn(original.value, 'screeningVersion') && (original.value as { screeningVersion?: unknown }).screeningVersion !== 1)
      throw new Error('lead-context-checkpoint-recovery')
    const settled = journal.state.context.epoch
    // A compaction written but not yet in place: the journal says which side of it the desk is on.
    const next = await this.#load(NEXT)
    if (next && next.header.epoch === settled) await rename(this.#path(NEXT), this.#path(FILE))
    else await rm(this.#path(NEXT), { force: true })
    const current = await this.#load(FILE)
    if (current && current.header.epoch === settled) { this.#adopt(current.header, current.turns, current.measured); this.#fileBytes = current.bytes }
    else await this.#seed(settled)
    await this.#recoverCheckpointStage()
    const kept = await readBoundedJson(this.#path(CHECKPOINTS), 600_000) as { version?: unknown; screeningVersion?: unknown; checkpoints?: unknown; count?: unknown } | undefined
    if (kept && Object.hasOwn(kept, 'screeningVersion') && kept.screeningVersion !== 1) throw new Error('lead-context-checkpoint-recovery')
    if (kept?.version === 1 && Array.isArray(kept.checkpoints)) {
      this.#checkpointScreening = kept.screeningVersion === 1
      this.#viewScreenPending = this.#checkpointScreening
      this.#checkpoints = readableCheckpoints(kept.checkpoints.slice(-CHECKPOINT_LIST))
      if (Number.isSafeInteger(kept.count) && (kept.count as number) >= 0) this.#count = kept.count as number
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
  /** Replace screened stored pieces and commit the notice with the epoch before installing the new file. */
  async #withholdStored(): Promise<void> {
    let screened = leadWithholdCredentialsReport(this.#turns)
    const screen = this.#connections.screen
    if (screen) {
      // Screen the same normalized views as the request guard, then isolate only refused blocks. A broker failure
      // is not evidence of a credential and must abort before either the journal or the context file changes.
      const views = leadCredentialScreenViews(screened.messages)
      if (await this.#screenRefused(JSON.stringify(views))) {
        const extra = views.map(turn => turn.map(() => false))
        const blocks = views.flatMap((turn, index) => turn.map((view, position) => ({ view, index, position })))
        // A clean half needs no individual broker calls. The final whole-screen check below still catches any
        // refusal that cannot be attributed to a block.
        const isolate = async (items: typeof blocks): Promise<void> => {
          if (!items.length || !await this.#screenRefused(JSON.stringify(items.map(item => item.view)))) return
          if (items.length === 1) { const item = items[0]!; extra[item.index]![item.position] = true; return }
          const middle = Math.floor(items.length / 2)
          await isolate(items.slice(0, middle)); await isolate(items.slice(middle))
        }
        await isolate(blocks)
        const exact = leadWithholdCredentialsReport(screened.messages, undefined, extra)
        screened = { messages: exact.messages, withheld: [...screened.withheld, ...exact.withheld] }
        // Some fields, such as tool IDs, must remain intact for the protocol. Never commit a partial repair that
        // still fails the screen; the caller can report the refusal instead.
        if (await this.#screenRefused(JSON.stringify(leadCredentialScreenViews(screened.messages)))) throw Object.assign(new Error('lead-secret-refused'), { wireCode: 'lead-secret-refused' })
      }
    }
    if (!screened.withheld.length) return
    // Withholding advances the journal epoch. Resolve an earlier checkpoint view
    // first, or keep the original conversation and stage intact for recovery.
    if (this.#checkpointPending) {
      try { await this.#finishCheckpointView() } catch { throw new Error('lead-context-recovery-required') }
    }
    const epoch = this.#epoch + 1
    const turns = await this.#snapshot(NEXT, epoch, screened.messages)
    await this.options.journal.contextWithheld()
    this.#needsRecovery = true
    this.#epoch = epoch
    this.#turns = turns
    await rename(this.#path(NEXT), this.#path(FILE))
    this.#fileBytes = Buffer.byteLength(await readFile(this.#path(FILE), 'utf8'))
    this.#measured = null
    this.#needsRecovery = false
  }
  async #screenRefused(text: string): Promise<boolean> {
    try { await this.#connections.screen?.(text); return false }
    catch (error) {
      if ((error as { wireCode?: unknown })?.wireCode === 'lead-secret-refused') return true
      throw error
    }
  }
  /** The whole conversation as one record, written beside the file and moved over it. */
  async #snapshot(name: string, epoch = this.#epoch, turns = this.#turns): Promise<readonly MessagesTurn[]> {
    turns = this.#bounded(leadMergedTurns(turns))
    if (name === FILE) this.#turns = turns
    const text = `${JSON.stringify(this.#header(epoch))}\n${JSON.stringify({ type: 'record', base: 0, extend: [], turns, measured: null } satisfies RecordLine)}\n`
    const temporary = this.#path(`${name}.tmp`)
    const handle = await open(temporary, 'w', 0o600)
    try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
    if (name === NEXT) { await rename(temporary, this.#path(NEXT)); return turns }
    await rename(temporary, this.#path(FILE))
    this.#fileBytes = Buffer.byteLength(text)
    this.#measured = null
    return turns
  }
  /** Never more than the disk bound: older tool results trimmed first, then the oldest turns dropped at a person's
   * turn. Compaction runs long before this; it is the bound, not the policy. */
  #bounded(turns: readonly MessagesTurn[]): readonly MessagesTurn[] {
    const room = LEAD_CONTEXT.diskBytes - 65_536
    if (leadContextBytes(turns) <= room) return turns
    let kept = leadPruneAndFold(turns)
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
  async #personSection(region: readonly MessagesTurn[], tail: readonly MessagesTurn[]): Promise<LeadCheckpointPerson> {
    const wakes = new Set(this.options.journal.state.messages.flatMap(message => message.wake ? [message.id] : []))
    const later = new Set(personIds(tail)), ids = [...new Set([...this.#known, ...spokenIds(region)])].filter(id => !later.has(id) && !wakes.has(id))
    const recorded = new Map(this.options.journal.state.messages.flatMap(message => message.role === 'user' && !message.wake ? [[message.id, message.text] as const] : []))
    const covered = new Set(ids)
    // A legacy journal message can now fail the same screen as the stored turn. Do not reintroduce it through a
    // checkpoint's independently reconstructed person section after the stored copy has been withheld.
    const words: { id: string; text: string }[] = []
    for (const message of this.options.journal.state.messages) {
      if (message.role !== 'user' || message.wake || !covered.has(message.id)) continue
      const refused = leadContainsSecret(message.text) || await this.#screenRefused(message.text)
      words.push({ id: message.id, text: refused ? LEAD_WITHHELD_TEXT : message.text })
    }
    return leadPersonQuotes(words, ids.filter(id => !recorded.has(id)))
  }
  /**
   * The journal's messages for user turns `open` names, in journal order, each with the lines the desk wrote to say a
   * reminder after it (`reminded`): no model step records such a line, so it goes with the turn it answers, and without
   * it the Lead would read the reminder as still owed. The one pairing both what a request carries and what a lost
   * step settles use.
   */
  #withReminderLines(open: (id: string) => boolean): LeadMessage[] {
    let taken = false
    return this.options.journal.state.messages.filter(message => {
      if (message.role === 'user') return taken = open(message.id)
      return taken && message.role === 'assistant' && message.reminded !== undefined
    })
  }
  /** Person messages the stored conversation does not hold yet, oldest first, as the words a request carries. */
  #unstored(): MessagesTurn[] {
    const known = new Set([...this.#known, ...personIds(this.#turns)])
    return this.#withReminderLines(id => !known.has(id)).flatMap(message => leadHistory([message]).slice(-1))
  }
  /**
   * What the host's next request starts from: the stored conversation, then the person's words it does not hold yet.
   * The cache mark goes after the person's words (`stable`); the step records everything after `base`, so those
   * words are stored once the model has answered them, and sent again if it never did.
   */
  request(): Promise<{ readonly messages: MessagesTurn[]; readonly epoch: number; readonly persons: readonly string[]; readonly base?: LeadContextMark; readonly stable?: LeadContextMark }> {
    return this.#serial(async () => {
      await this.#withholdStored()
      if (!this.#turns.length) {
        const fresh = this.#unstored()
        if (fresh.length) {
          parseLeadContextTurns(leadMergedTurns(fresh))
          await this.#append({ base: 0, extend: [], turns: fresh, measured: null })
        }
      }
      const unstored = this.#unstored()
      const stored = [...leadPairedTurns(this.#turns)], messages = [...leadMergedTurns([...stored, ...unstored])]
      parseLeadContextTurns(messages)
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
      // Answered means a reply from the model: a line the desk wrote to say a reminder is not one.
      if (!messages.slice(last + 1).some(message => message.role === 'assistant' && message.reminded === undefined)) return
      // In journal order: each open message with its reminder lines, then every reply after the last of them.
      const taken = new Set(this.#withReminderLines(id => open.includes(id)).map(message => message.id))
      // Convert each selected message separately, as #unstored does: applying
      // the request-history cap here would lose earlier answered references.
      const turns = messages.filter((message, index) => taken.has(message.id) || index > last && message.role === 'assistant')
        .flatMap(message => leadHistory([message]).slice(-1))
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
      // A step that kept no turns (a quiet desk wake) reports only what its request measured.
      if (!input.extend.length && !input.turns.length) { if (tokens !== null) { this.#overhead = Math.max(0, tokens - leadEstimatedTokens(bytes)); this.#measured = { tokens, bytes } } return }
      const base = input.epoch === this.#epoch ? input.base : this.#turns.length
      await this.#append({ base, extend: input.extend, turns: input.turns, measured: tokens === null ? null : { tokens, bytes } },
        tokens === null ? undefined : Math.max(0, tokens - leadEstimatedTokens(bytes)))
    })
  }
  async #append(record: Omit<RecordLine, 'type'>, overhead?: number): Promise<void> {
    record = { ...record, turns: leadMergedTurns(record.turns) }
    // Refuse records that reopening cannot parse, before changing durable or in-memory context.
    this.#parseRecord({ type: 'record', ...record })
    const applied = this.#applied(this.#turns, record)
    // Validate each resulting turn with its preceding assistant when it contains tool results.
    for (let i = 0; i < applied.length; i++) {
      const turn = applied[i]!
      const hasResults = turn.role === 'user' && turn.content.some(block => block.type === 'tool_result')
      parseLeadContextTurns(hasResults && i > 0 ? [applied[i - 1]!, turn] : [turn])
    }
    const line = `${JSON.stringify({ type: 'record', ...record } satisfies RecordLine)}\n`
    if (this.#fileBytes + Buffer.byteLength(line) > LEAD_CONTEXT.diskBytes) {
      const known = this.#known
      try { parseLeadContextTurns(this.#bounded(applied)) } finally { this.#known = known }
    }
    this.#turns = applied
    if (overhead !== undefined) this.#overhead = overhead
    if (record.measured) this.#measured = record.measured
    if (this.#fileBytes + Buffer.byteLength(line) > LEAD_CONTEXT.diskBytes) { const measured = this.#measured; await this.#snapshot(FILE); this.#measured = measured; return }
    await appendFile(this.#path(FILE), line, { mode: 0o600 })
    this.#fileBytes += Buffer.byteLength(line)
  }
  /** The stored conversation for a child whose copy is from another epoch; null when its copy is current. */
  read(epoch: number, room = READ_BYTES): Promise<{ readonly epoch: number; readonly messages: readonly MessagesTurn[] } | null> {
    return this.#serial(async () => {
      await this.#withholdStored()
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
    if (this.#needsRecovery) throw new Error('lead-context-recovery-required')
    if (this.#compacting || this.options.journal.state.context.pending) return 'busy'
    this.#compacting = true
    try {
      if (this.#checkpointPending) await this.#serial(async () => {
        try { await this.#finishCheckpointView() } catch { throw new Error('lead-context-recovery-required') }
      })
      return await this.#compact(trigger, send)
    }
    finally { this.#compacting = false }
  }
  get compacting(): boolean { return this.#compacting }
  async #compact(trigger: LeadCompactionTrigger, send: LeadContextSend): Promise<LeadCompactionOutcome> {
    await this.#serial(() => this.#withholdStored())
    const { journal, now, nextId } = this.options
    const id = nextId(), beforeTokens = this.tokens()
    const pruned = leadPruneAndFold(this.#turns)
    let split = leadContextSplit(this.#turns, this.window)
    const before = this.pressure()
    // Nothing worth doing: wait until the conversation grows by the hysteresis before looking again, and never look
    // sooner than the usual line.
    const leave = () => { this.#softAt = leadNextSoftShare(before); return 'nothing' as const }
    if (pruned === this.#turns && split === null) return leave()
    const share = (turns: readonly MessagesTurn[]) => leadContextPressure({ window: this.window, tokens: this.tokens(turns), bytes: leadContextBytes(turns), turns: turns.length })
    // A kept tail that stays past the hard line by itself would bring the next compaction straight back: keep the
    // smallest tail instead, its older tool results trimmed too.
    const room = leadCheckpointTurn(id, 'x'.repeat(LEAD_CONTEXT.checkpointChars), true)
    let smallest = false
    if (split !== null && share([room, ...leadPruneAndFold(this.#turns.slice(split))]) >= LEAD_CONTEXT.hardShare) {
      const fewer = leadContextSplit(this.#turns, this.window, true)
      if (fewer !== null) { split = fewer; smallest = true }
    }
    // Every compaction starts an epoch, which costs the next requests their cache: an idle run that would barely lower
    // the pressure is skipped, and the pressure comes straight back after it anyway (#2171). A prune is measured by
    // what it leaves; a summary by the turns it folds less the checkpoint that replaces them, taken at its full length.
    const idle = trigger === 'soft'
    let prune = pruned !== this.#turns && (split === null || trigger !== 'manual' && share(pruned) < this.#softAt)
    if (prune && idle && before - share(pruned) < LEAD_CONTEXT.minSaving) prune = false
    const kept = (from: number) => smallest ? leadPruneAndFold(this.#turns.slice(from), 0) : this.#turns.slice(from)
    if (!prune && (split === null || idle && before - share([room, ...kept(split)]) < LEAD_CONTEXT.minSaving)) return leave()
    try {
      if (prune) {
        await journal.contextCompactionStarted(id, now(), trigger)
        const afterTokens = this.tokens(pruned)
        await this.#replace(id, current => leadPruneAndFold(current), () => journal.contextPruned({ id, at: now(), beforeTokens, afterTokens }), share(pruned))
        return 'pruned'
      }
      if (split === null) { await journal.contextCompactionFailed(id, 'blocked'); return 'nothing' }
      const from = split
      const region = [...leadPairedTurns(this.#turns.slice(0, from))]
      const previous = leadCheckpointText(region[0])
      let requiredIds: readonly string[] = []
      try { requiredIds = await this.#connections.ledgerIds?.() ?? [] } catch { /* A checkpoint without the ledger's ids still stands. */ }
      let deskNow: string | null = null
      try { deskNow = await this.#connections.deskNow?.() ?? null } catch { /* Without it the checkpoint is written from the conversation alone. */ }
      const regionBytes = leadContextBytes(region)
      // The person's words come from the desk, never from the model: only a message the desk recorded as theirs.
      const quotes = await this.#personSection(region, this.#turns.slice(from)), person = leadPersonSection(quotes)
      await journal.contextCompactionStarted(id, now(), trigger)
      const attempts = journal.state.context.failures >= LEAD_CONTEXT.breaker ? 1 : LEAD_CONTEXT.attempts
      let text: string | null = null, usdMicros = 0, turnedAway = 0
      for (let attempt = 0; attempt < attempts && text === null; attempt++) {
        const spent = journal.state.budget?.leadUsdMicros ?? 0
        let reason: string
        try {
          const result = await send({ messages: leadCheckpointMessages(region, leadCheckpointInstruction({ merging: previous !== null, requiredIds, deskNow })),
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
        // The provider refused the checkpoint request itself: the same request again fares no better, and stopping
        // here would leave the conversation to grow until it is too long. The desk writes this one. A refusal of the
        // moment (a timeout, a conflict) gets one more ask first.
        if (reason === 'lead-messages-request' || reason === 'lead-messages-transient' && turnedAway++) break
      }
      const fallback = text === null
      text ??= leadFallbackCheckpoint({ region, previous, ledgerIds: requiredIds, person })
      const checkpoint = leadCheckpointTurn(id, text, fallback)
      const tailOf = (current: readonly MessagesTurn[]) => smallest ? leadPruneAndFold(current.slice(from), 0) : current.slice(from)
      const after = [checkpoint, ...tailOf(this.#turns)]
      const afterTokens = this.tokens(after), afterShare = share(after)
      const revisions = personIds(region).flatMap(person => journal.state.messages.find(message => message.id === person)?.revision ?? [])
      const fromSeq = revisions.length ? Math.min(...revisions) : 0, toSeq = revisions.length ? Math.max(...revisions) : fromSeq
      // A missing or failing screen cannot authorize new display bytes on disk.
      let shown: string | null = null
      const displayScreen = this.#connections.screen
      if (displayScreen) {
        const candidate = leadClip(text, 32_768, '')
        try { await displayScreen(candidate); shown = candidate } catch { /* keep the refusal representation */ }
      }
      const display: LeadContextCheckpoint = { id, at: now(), fallback, beforeTokens, afterTokens,
        text: shown === null ? null : leadCheckpointModelPart(shown), ...(shown === null ? {} : { person: quotes }) }
      await this.#replace(id, current => [checkpoint, ...tailOf(current)], () => journal.contextCompactionApplied({ id, at: now(), fromSeq, toSeq, beforeTokens, afterTokens,
        model: this.options.model, usdMicros, fallback }), afterShare, display, displayScreen, personIds(region))
      // Still past the hard line with the smallest tail: stop compacting until it grows by the hysteresis, and say so.
      this.#fullAt = afterShare >= LEAD_CONTEXT.hardShare ? afterShare : null
      return 'applied'
    } catch (error) {
      if (!this.#needsRecovery && journal.state.context.pending?.id === id) await journal.contextCompactionFailed(id, 'interrupted').catch(() => {})
      throw error
    }
  }
  /**
   * The two-phase swap: the new conversation is written beside the old, the journal records the new epoch, then it
   * is moved into place. `build` makes it from the conversation as it stands then, so turns recorded while the model
   * was writing follow the tail they came after.
   */
  async #replace(id: string, build: (current: readonly MessagesTurn[]) => readonly MessagesTurn[], commit: () => Promise<void>, share: number,
    display?: LeadContextCheckpoint, displayScreen?: LeadContextConnections['screen'], remember?: readonly string[]): Promise<void> {
    await this.#serial(async () => {
      if (this.#checkpointPending) throw new Error('lead-context-recovery-required')
      const turns = leadMergedTurns(build(this.#turns))
      const epoch = this.#epoch + 1
      if (display) {
        const screen = this.#connections.screen
        if (display.text !== null && (!screen || screen !== displayScreen)) throw new Error('lead-context-checkpoint-screen')
        // A legacy file can predate screening. Do not copy its prose into a new
        // stage without authorizing both the model text and the person's quotes.
        const prose = this.#checkpoints.slice(-(CHECKPOINT_LIST - 1)).flatMap(checkpoint => {
          // The person section is displayed before the model sections. Screen
          // them together so a credential split across sections cannot pass.
          const parts = [...(checkpoint.person?.messages.map(message => message.text) ?? []),
            ...(checkpoint.text === null ? [] : [checkpoint.text])]
          return parts.length ? [parts.join('\n')] : []
        })
        if (prose.length && !screen) throw new Error('lead-context-checkpoint-screen')
        try { for (const entry of prose) await screen!(entry) } catch { throw new Error('lead-context-checkpoint-screen') }
        if (screen !== this.#connections.screen) throw new Error('lead-context-checkpoint-screen')
      }
      let stage: CheckpointStage | undefined
      if (display) {
        const existing = await readBoundedJsonResult(this.#path(CHECKPOINT_STAGE), 600_000)
        if (existing.kind !== 'missing') { this.#needsRecovery = true; throw new Error('lead-context-checkpoint-recovery') }
        stage = checkpointStageOf({ version: 1, id, epoch, count: this.#counted() + 1,
          checkpoints: [...this.#checkpoints, display].slice(-CHECKPOINT_LIST) })
        if (Buffer.byteLength(JSON.stringify(stage)) > 600_000 ||
            Buffer.byteLength(JSON.stringify({ version: 1, screeningVersion: 1, count: stage.count, checkpoints: stage.checkpoints })) > 600_000)
          throw new Error('lead-context-checkpoint-stage')
      }
      if (remember) this.#remember(remember)
      this.#softAt = leadNextSoftShare(share)
      await this.#snapshot(NEXT, epoch, turns)
      if (stage) {
        // An error can follow the stage rename; replay determines whether the journal committed.
        this.#needsRecovery = true
        await writeAtomicJson(this.#path(CHECKPOINT_STAGE), stage, async () => {
          const existing = await readBoundedJsonResult(this.#path(CHECKPOINT_STAGE), 600_000)
          if (existing.kind !== 'missing') throw new Error('lead-context-checkpoint-recovery')
        })
      }
      await commit()
      if (this.options.journal.state.context.epoch !== epoch) throw new Error(`lead-context-epoch-${id}`)
      this.#epoch = epoch
      this.#turns = turns
      await rename(this.#path(NEXT), this.#path(FILE))
      const directory = await open(this.options.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
      this.#fileBytes = Buffer.byteLength(await readFile(this.#path(FILE), 'utf8'))
      this.#measured = null
      if (stage) {
        this.#checkpoints = [...stage.checkpoints]
        this.#count = stage.count
        this.#checkpointScreening = true
        // A screen installed while the commit was in flight has not seen this
        // new view yet, even if the preceding legacy view needed no mask.
        if (this.#connections.screen !== displayScreen) this.#viewScreenPending = true
        // The journal and conversation file are now known committed; failure
        // below concerns only the independently recoverable checkpoint view.
        this.#needsRecovery = false
        this.#checkpointPending = true
        try {
          await writeAtomicJson(this.#path(CHECKPOINTS), { version: 1, screeningVersion: 1, count: stage.count, checkpoints: stage.checkpoints }, async () => {})
          await this.#removeCheckpointStage()
          this.#checkpointPending = false
        } catch { /* reopen resolves the durable stage or already-durable canonical file */ }
      }
    })
  }

  /** The kept count, or more if the thread marks more (a desk that kept no count, or stopped before writing it). */
  #counted(): number {
    const marked = this.options.journal.state.messages.reduce((sum, message) => sum + (message.checkpoint ? 1 : 0), 0)
    return Math.max(this.#count, this.#checkpoints.length, marked)
  }
  facts(): LeadContextFacts {
    const wakes = this.options.journal.state.wakes.flatMap(wake => wake.tokens ? [wake.tokens] : [])
    const total = wakes.reduce((sum, tokens) => sum + tokens.input + tokens.cacheRead + tokens.cacheWrite, 0)
    const checkpoints = this.#viewScreenPending ? this.#checkpoints.map(checkpoint => {
      const { person: _person, ...hidden } = checkpoint
      return { ...hidden, text: null }
    }) : this.#checkpoints
    return parseLeadContextFacts({ version: 1, windowTokens: this.window, usedTokens: this.#turns.length ? Math.min(100_000_000, Math.round(this.tokens())) : null,
      cacheHitRate: total ? wakes.reduce((sum, tokens) => sum + tokens.cacheRead, 0) / total : null, compacting: this.#compacting, checkpoints: readableCheckpoints(checkpoints),
      count: this.#counted(), ...(this.#fullAt !== null ? { full: true } : {}) })
  }

  /** A view read retries a temporary screen outage; synchronous consumers remain masked. */
  async readFacts(): Promise<LeadContextFacts> {
    if (this.#viewScreenPending) {
      const screen = this.#connections.screen
      if (!screen) throw Object.assign(new Error('lead-protection-unavailable'), { wireCode: 'lead-protection-unavailable' })
      await this.connect({ screen })
      if (this.#viewScreenPending) throw Object.assign(new Error('lead-protection-unavailable'), { wireCode: 'lead-protection-unavailable' })
    }
    return this.facts()
  }
}
