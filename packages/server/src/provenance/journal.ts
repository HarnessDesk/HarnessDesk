import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { WorkSlices, type SliceOptions } from './slices.js'

export type JournalKind = 'ref' | 'commit' | 'range' | 'link' | 'cursor' | 'gap'
export interface JournalEntry {
  readonly seq: number
  readonly kind: JournalKind
  readonly value: unknown
}
export interface JournalRead {
  readonly entries: readonly JournalEntry[]
  readonly broken: boolean
  readonly generation: number
}
export interface JournalReadOptions {
  /**
   * `deep` protects callers from mutating journal-owned records. `shallow`
   * gives read-only consumers their own stable list while sharing the
   * immutable-by-convention records; this avoids duplicating large journals.
   */
  readonly copy?: 'deep' | 'shallow'
  /** Number of entries already consumed by an incremental reader. */
  readonly after?: number
  /** A compaction invalidates an older reader prefix. */
  readonly generation?: number
  readonly slices?: SliceOptions
}
export const JOURNAL_LIMIT = 64 * 1024
/** Replay retains decoded observations; a line limit alone does not bound that heap. */
export const JOURNAL_BYTE_LIMIT = 64 * 1024 * 1024
export class ProvenanceJournalLimitError extends Error {
  constructor() { super('provenance-journal-limit'); this.name = 'ProvenanceJournalLimitError' }
}
export class ProvenanceJournalChangedError extends Error {
  constructor() { super('provenance-journal-changed'); this.name = 'ProvenanceJournalChangedError' }
}
export class ProvenanceJournalStorageError extends Error {
  constructor(cause: unknown) {
    super('provenance-write-failed', { cause })
    this.name = 'ProvenanceJournalStorageError'
  }
}
export const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullable = (value: unknown, check: (value: unknown) => boolean) => value === null || check(value)
const array = (value: unknown, check: (value: unknown) => boolean): value is unknown[] =>
  Array.isArray(value) && value.every((item) => check(item))
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const strings = (value: unknown) => array(value, text)
const patch = (value: unknown): boolean => object(value) &&
  ((value.stable === '' && value.exact === '') || (sha(value.stable) && sha(value.exact))) && strings(value.files)
const filePatch = (value: unknown): boolean => object(value) && text(value.path) &&
  sha(value.stable) && sha(value.exact)
const pair = (check: (value: unknown) => boolean) => (value: unknown): boolean =>
  Array.isArray(value) && value.length === 2 && text(value[0]) && check(value[1])
const logCursor = (value: unknown): boolean => object(value) && text(value.fileId) &&
  number(value.offset) && typeof value.tailHash === 'string' && /^[a-f0-9]{64}$/.test(value.tailHash)

/** Check the whole checkpoint after its bounded parts have been joined. */
export const checkpointValue = (value: unknown): boolean => object(value) &&
  number(value.generation) && array(value.refs, pair(sha)) &&
  array(value.heads, pair((head) => nullable(head, sha))) && array(value.logs, pair(logCursor)) &&
  array(value.frontier, sha) && number(value.capturedThrough) && number(value.scanStartedAt) &&
  strings(value.rangeKeys) && strings(value.rangePending) && array(value.baseline, sha) &&
  (value.openedAt === undefined || number(value.openedAt)) &&
  (value.historyFloor === undefined || number(value.historyFloor))

/** The same admission rule is used for disk and backups; raw patches have no slot. */
export const validValue = (kind: JournalKind, value: unknown, prefix = Infinity): boolean => {
  if (!object(value) || !text(value.id, 200)) return false
  const fields: Record<JournalKind, readonly string[]> = {
    ref: ['id', 'ref', 'checkout', 'before', 'after', 'recordedAt'],
    commit: ['id', 'sha', 'tree', 'parents', 'firstSeenAt', 'fingerprintVersion', 'discoveredBy', 'checkoutHints', 'window', 'patch', 'files', 'why'],
    range: ['id', 'from', 'to', 'commits', 'patch', 'seats', 'ambiguous', 'at'],
    link: ['id', 'sha', 'seats', 'sourceIds', 'evidenceIds', 'retainedPaths', 'coverage', 'via', 'reason', 'at'],
    cursor: ['id', 'type', 'bytes', 'parts', 'hash'],
    gap: ['id', 'reason', 'from', 'to'],
  }
  const allowed = 'restoredAt' in value ? ['id', 'restoredAt', 'data'] : fields[kind]
  if (!allowed || Object.keys(value).some((key) => !allowed.includes(key))) return false
  if ('restoredAt' in value) {
    return kind !== 'cursor' && number(value.restoredAt) && object(value.data) &&
      !('restoredAt' in value.data) && validValue(kind, value.data, prefix)
  }
  switch (kind) {
    case 'ref':
      return text(value.ref) && (value.ref === 'HEAD' || value.ref.startsWith('refs/')) && nullable(value.checkout, text) && nullable(value.before, sha) &&
        nullable(value.after, sha) && nullable(value.recordedAt, number)
    case 'commit':
      return sha(value.sha) && sha(value.tree) && array(value.parents, sha) &&
        number(value.firstSeenAt) && value.fingerprintVersion === 1 &&
        strings(value.discoveredBy) && strings(value.checkoutHints) && object(value.window) &&
        nullable(value.window.from, number) && number(value.window.to) &&
        nullable(value.patch, patch) && array(value.files, filePatch) && nullable(value.why, text)
    case 'range':
      return sha(value.from) && sha(value.to) && array(value.commits, sha) &&
        value.commits.length <= 64 && patch(value.patch) && strings(value.seats) &&
        typeof value.ambiguous === 'boolean' && number(value.at)
    case 'link':
      return sha(value.sha) && strings(value.seats) && strings(value.sourceIds) &&
        strings(value.evidenceIds) && strings(value.retainedPaths) &&
        ['complete', 'partial', 'none'].includes(String(value.coverage)) &&
        [null, 'observed', 'patch', 'amend', 'squash'].includes(value.via as string | null) &&
        nullable(value.reason, text) && number(value.at)
    case 'gap':
      return text(value.reason, 200) && nullable(value.from, number) && number(value.to)
    case 'cursor':
      if (value.type === 'part') return typeof value.bytes === 'string' && value.bytes.length <= 12000
      return value.type === 'checkpoint' && array(value.parts, (seq) => number(seq) && seq > 0 && seq <= prefix) &&
        typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash)
  }
}
const kinds = new Set<JournalKind>(['ref', 'commit', 'range', 'link', 'cursor', 'gap'])
const keyOf = (kind: JournalKind, value: unknown) => `${kind}:${(value as { id: string }).id}`

const normalizeStorageError = (error: unknown): Error =>
  error instanceof Error && error.message.startsWith('provenance-')
    ? error : new ProvenanceJournalStorageError(error)

const serializeEntry = ({ seq, kind, value }: JournalEntry): Buffer => {
  const body = { version: 1, seq, kind, value }
  return Buffer.from(`${JSON.stringify({ ...body, checksum: digest(body) })}\n`)
}
const sameFile = (before: Stats, after: Stats): boolean =>
  before.size === after.size && before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs && before.ino === after.ino && before.dev === after.dev
interface StreamEntry {
  readonly entry: JournalEntry
  readonly position: number
  readonly length: number
  readonly consumed: number
}

/** One validator serves ordinary replay and bounded historical recovery. */
async function* streamEntries(file: string, slices: WorkSlices, limit = Infinity): AsyncGenerator<StreamEntry> {
  let pending = Buffer.alloc(0)
  let sequence = 0
  let position = 0
  let consumed = 0
  for await (const chunk of createReadStream(file, { highWaterMark: 16 * 1024 })) {
    consumed += chunk.length
    if (consumed > limit) throw new ProvenanceJournalLimitError()
    pending = Buffer.concat([pending, chunk as Buffer])
    let end: number
    while ((end = pending.indexOf(10)) >= 0) {
      const length = end + 1
      if (length > JOURNAL_LIMIT) throw new Error('journal-line-limit')
      const raw = pending.subarray(0, end)
      const text = raw.toString('utf8')
      const line: unknown = JSON.parse(text)
      if (!Buffer.from(text).equals(raw) || !object(line)) throw new Error('journal-shape')
      const { version, seq, kind, value, checksum } = line
      if (version !== 1 || seq !== sequence + 1 || !kinds.has(kind as JournalKind) ||
        !validValue(kind as JournalKind, value, sequence) || checksum !== digest({ version, seq, kind, value })) {
        throw new Error('journal-damaged')
      }
      sequence += 1
      yield { entry: { seq: sequence, kind: kind as JournalKind, value }, position, length, consumed }
      position += length
      pending = pending.subarray(length)
      await slices.step()
    }
    if (pending.length >= JOURNAL_LIMIT) throw new Error('journal-line-limit')
  }
  if (pending.length) throw new Error('journal-torn-tail')
}

const liveCursors = (manifest: JournalEntry | undefined): ReadonlySet<number> =>
  new Set(manifest ? [manifest.seq, ...(manifest.value as { parts: number[] }).parts] : [])

/** Renumber only retained cursors; historical rows never need a sequence map. */
async function* compactEntries(
  source: AsyncIterable<JournalEntry> | Iterable<JournalEntry>, manifest: JournalEntry | undefined, slices: WorkSlices,
): AsyncGenerator<JournalEntry> {
  const keep = liveCursors(manifest)
  const sequence = new Map<number, number>()
  let count = 0
  for await (const entry of source) {
    await slices.step()
    if (entry.kind === 'cursor' && !keep.has(entry.seq)) continue
    const seq = ++count
    if (entry.kind === 'cursor') sequence.set(entry.seq, seq)
    const value = entry.seq === manifest?.seq
      ? { ...(entry.value as object), parts: (entry.value as { parts: number[] }).parts.map((part) => sequence.get(part)) }
      : entry.value
    yield { seq, kind: entry.kind, value }
  }
}

/** Both recovery paths share the atomic rewrite and source-change fence. */
async function rewriteJournal(file: string, before: Stats, source: AsyncIterable<JournalEntry>): Promise<number> {
  const temporary = `${file}.compact-${randomUUID()}`
  const cursors: JournalEntry[] = []
  let written = 0
  try {
    const output = await fs.open(temporary, 'wx', 0o600)
    try {
      for await (const entry of source) {
        const bytes = serializeEntry(entry)
        written += bytes.length
        if (written > JOURNAL_BYTE_LIMIT) throw new ProvenanceJournalLimitError()
        if (entry.kind === 'cursor') cursors.push(entry)
        if ((await output.write(bytes)).bytesWritten !== bytes.length) throw new Error('provenance-short-write')
      }
      readCheckpoint(cursors)
      await output.sync()
    } finally { await output.close() }
    if (!sameFile(before, await fs.stat(file))) throw new ProvenanceJournalChangedError()
    await fs.rename(temporary, file)
    return written
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
}

/** Only obsolete cursors may be removed; history never gets pruned to fit. */
async function compactOversized(file: string, slices: WorkSlices): Promise<void> {
  const before = await fs.stat(file)
  let manifest: JournalEntry | undefined
  let historicalBytes = 0
  let historicalCount = 0
  for await (const { entry } of streamEntries(file, slices)) {
    if (entry.kind !== 'cursor') {
      // The full envelope with histories alone is a lower bound on retained
      // bytes. Obsolete cursors must not inflate its sequence digit count.
      historicalBytes += serializeEntry({ ...entry, seq: ++historicalCount }).length
      if (historicalBytes > JOURNAL_BYTE_LIMIT) throw new ProvenanceJournalLimitError()
    } else if ((entry.value as { type: string }).type === 'checkpoint') manifest = entry
  }
  const source = async function* () {
    for await (const { entry } of streamEntries(file, slices)) yield entry
  }
  await rewriteJournal(file, before, compactEntries(source(), manifest, slices))
}

export class ProvenanceJournal {
  readonly #file: string
  #entries: JournalEntry[] = []
  #ids = new Map<string, number>()
  #durableBytes = 0
  #sequence = 0
  #generation = 0
  readonly #compactOnOpen: boolean
  #load: Promise<void> | null = null
  #tail: Promise<void> = Promise.resolve()
  #broken = false
  #failed: Error | null = null

  constructor(file: string, options: { compactOnOpen?: boolean } = {}) {
    this.#file = file
    this.#compactOnOpen = !!options.compactOnOpen
  }

  async #loadOnce(options: JournalReadOptions = {}): Promise<void> {
    this.#load ??= this.#stream(options.slices)
    await this.#load
  }

  async #stream(options?: SliceOptions): Promise<void> {
    const slices = new WorkSlices(options)
    // Retain historical observations and the checkpoint in force. Offsets let
    // later manifests reuse earlier parts without keeping superseded bytes.
    const cursors = new Map<number, JournalEntry>()
    const positions = new Map<number, { position: number; length: number }>()
    try {
      if ((await fs.stat(this.#file)).size > JOURNAL_BYTE_LIMIT) await compactOversized(this.#file, slices)
      for await (const { entry, position, length, consumed } of streamEntries(this.#file, slices, JOURNAL_BYTE_LIMIT)) {
        this.#sequence = entry.seq
        this.#durableBytes = consumed
        if (this.#compactOnOpen && entry.kind === 'cursor') {
          positions.set(entry.seq, { position, length })
          cursors.set(entry.seq, entry)
          if ((entry.value as { type: string }).type === 'checkpoint') {
            const keep = liveCursors(entry)
            for (const seq of keep) {
              if (cursors.has(seq)) continue
              const offset = positions.get(seq)
              if (!offset) throw new Error('provenance-invalid-checkpoint')
              const file = await fs.open(this.#file, 'r')
              try {
                const bytes = Buffer.alloc(offset.length)
                if ((await file.read(bytes, 0, bytes.length, offset.position)).bytesRead !== bytes.length) throw new Error('journal-short-read')
                const body = JSON.parse(bytes.toString('utf8')) as JournalEntry
                cursors.set(seq, { seq: body.seq, kind: body.kind, value: body.value })
              } finally { await file.close() }
            }
            for (const seq of cursors.keys()) if (!keep.has(seq)) cursors.delete(seq)
          }
        } else {
          this.#entries.push(entry)
          this.#ids.set(keyOf(entry.kind, entry.value), entry.seq)
        }
      }
    } catch (error) {
      if (error instanceof ProvenanceJournalLimitError || error instanceof ProvenanceJournalChangedError) {
        this.#entries = []
        this.#ids.clear()
        throw error
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#broken = true
    }
    if (this.#compactOnOpen) {
      this.#entries = [...this.#entries, ...cursors.values()].sort((a, b) => a.seq - b.seq)
      this.#ids = new Map(this.#entries.map((entry) => [keyOf(entry.kind, entry.value), entry.seq]))
      if (!this.#broken) {
        try {
          await this.#compactLoaded(true)
        } catch (error) {
          if (error instanceof ProvenanceJournalChangedError || error instanceof ProvenanceJournalLimitError) {
            this.#entries = []
            this.#ids.clear()
            throw error
          }
          // Replay retained the original history. A replacement failure must
          // not replay into those arrays or poison later reads and retries.
          this.#load = Promise.resolve()
          throw error
        }
      }
    }
  }

  async read(options: JournalReadOptions = {}): Promise<JournalRead> {
    await this.#loadOnce(options)
    await this.#tail
    const source = this.#entries
    const end = source.length
    const generation = this.#generation
    const entries: JournalEntry[] = []
    const slices = new WorkSlices(options.slices)
    for (let at = options.generation !== undefined && options.generation !== generation ? 0 : options.after ?? 0; at < end; at += 1) {
      await slices.step()
      const entry = source[at]!
      entries.push(options.copy === 'shallow' ? entry : structuredClone(entry))
    }
    return {
      entries,
      broken: this.#broken,
      generation,
    }
  }

  append(kind: JournalKind, value: unknown): Promise<number> {
    // Snapshot now; the caller cannot change a queued record before its checksum.
    const saved = structuredClone(value)
    const next = this.#tail.then(async () => {
      await this.#loadOnce()
      return this.#transaction((append) => append(kind, saved))
    })
    this.#tail = next.then(() => {}, () => {})
    return next
  }

  /** Plan the actual sequence ids and serialized bytes without writing parts. */
  async #plan<T>(
    operation: (append: (kind: JournalKind, value: unknown) => Promise<number>) => Promise<T>,
    sequence = this.#sequence, ids: ReadonlyMap<string, number> = this.#ids,
  ): Promise<{ entries: JournalEntry[]; bytes: number; result: T }> {
    const entries: JournalEntry[] = []
    const staged = new Map<string, number>()
    const slices = new WorkSlices()
    let bytes = 0
    const result = await operation(async (kind, value) => {
      await slices.step()
      if (!validValue(kind, value, sequence)) throw new Error('provenance-invalid-record')
      const key = keyOf(kind, value)
      const existing = staged.get(key) ?? ids.get(key)
      if (existing !== undefined) return existing
      const entry = { seq: ++sequence, kind, value }
      const length = serializeEntry(entry).length
      if (length > JOURNAL_LIMIT) throw new Error('provenance-line-limit')
      bytes += length
      entries.push(entry)
      staged.set(key, sequence)
      return sequence
    })
    return { entries, bytes, result }
  }

  async #transaction<T>(operation: (append: (kind: JournalKind, value: unknown) => Promise<number>) => Promise<T>): Promise<T> {
    if (this.#broken) throw new Error('provenance-journal-damaged')
    if (this.#failed) throw this.#failed
    let plan = await this.#plan(operation)
    if (this.#durableBytes + plan.bytes > JOURNAL_BYTE_LIMIT) {
      // A transaction is admitted whole. Renumber only before assigning its
      // durable part ids, and refuse before touching the source if it cannot fit.
      const compacted = await this.#compactLoaded(true, async (entries, bytes) => {
        const ids = new Map(entries.map((entry) => [keyOf(entry.kind, entry.value), entry.seq]))
        const candidate = await this.#plan(operation, entries.length, ids)
        if (bytes + candidate.bytes > JOURNAL_BYTE_LIMIT) throw new ProvenanceJournalLimitError()
      })
      if (!compacted) throw new ProvenanceJournalLimitError()
      plan = await this.#plan(operation)
    }
    for (const entry of plan.entries) await this.#appendLoaded(entry.kind, entry.value)
    return plan.result
  }

  async #appendLoaded(kind: JournalKind, saved: unknown): Promise<number> {
    if (this.#broken) throw new Error('provenance-journal-damaged')
    if (this.#failed) throw this.#failed
    // Opening replay may have dropped obsolete cursors before replacement
    // failed. Its retained count is not the original file's sequence prefix.
    if (!validValue(kind, saved, this.#sequence)) throw new Error('provenance-invalid-record')
    const key = keyOf(kind, saved)
    const existing = this.#ids.get(key)
    if (existing !== undefined) return existing
    const entry = { seq: this.#sequence + 1, kind, value: saved }
    const bytes = serializeEntry(entry)
    if (bytes.length > JOURNAL_LIMIT) throw new Error('provenance-line-limit')
    try {
      await fs.mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
      const file = await fs.open(this.#file, 'a', 0o600)
      try {
        const size = (await file.stat()).size
        if (size !== this.#durableBytes) throw new ProvenanceJournalChangedError()
        if (size + bytes.length > JOURNAL_BYTE_LIMIT) throw new ProvenanceJournalLimitError()
        if ((await file.write(bytes)).bytesWritten !== bytes.length) throw new Error('provenance-short-write')
        await file.sync()
      } finally {
        await file.close()
      }
    } catch (error) {
      // A refused size check wrote nothing and can be recovered by compaction.
      if (error instanceof ProvenanceJournalLimitError || error instanceof ProvenanceJournalChangedError) throw error
      this.#failed = normalizeStorageError(error)
      throw this.#failed
    }
    this.#durableBytes += bytes.length
    this.#entries.push(entry)
    this.#sequence = entry.seq
    this.#ids.set(key, entry.seq)
    return entry.seq
  }

  /** Parts, manifest and replacement share one queue slot, including concurrent callers. */
  checkpoint(value: unknown): Promise<void> {
    const saved = structuredClone(value)
    const next = this.#tail.then(async () => {
      await this.#loadOnce()
      await this.#transaction((append) => checkpointParts(append, saved))
      await this.#compactLoaded(false)
    })
    this.#tail = next.then(() => {}, () => {})
    return next
  }

  /** Serialize replacement with appends; a failed replacement never poisons the original journal. */
  compact(force = false): Promise<boolean> {
    const next = this.#tail.then(async () => {
      await this.#loadOnce()
      return this.#compactLoaded(force)
    })
    this.#tail = next.then(() => {}, () => {})
    return next
  }

  async #compactLoaded(
    force: boolean, reserve?: (entries: readonly JournalEntry[], bytes: number) => Promise<void>,
  ): Promise<boolean> {
    try {
      if (this.#broken) throw new Error('provenance-journal-damaged')
      if (this.#failed) throw this.#failed
      const manifest = this.#entries.findLast((entry) => entry.kind === 'cursor' &&
        object(entry.value) && entry.value.type === 'checkpoint')
      // Every historical observation is live. Only superseded checkpoint parts
      // and manifests are disposable; amend proofs may still use older decisions.
      const keep = liveCursors(manifest)
      const slices = new WorkSlices()
      let obsolete = 0
      let bytes = 0
      for (const entry of this.#entries) {
        await slices.step()
        if (entry.kind === 'cursor' && !keep.has(entry.seq)) {
          obsolete += 1
          bytes += Buffer.byteLength(JSON.stringify(entry.value))
        }
      }
      // Sparse replay has already discarded cursors in memory; replacement is
      // still due until its rename succeeds, including after a failed attempt.
      const sparse = this.#sequence > this.#entries.length
      if (!obsolete && !sparse) return false
      if (!force && !sparse && obsolete * 2 <= this.#entries.length && bytes < 32 * 1024 * 1024) return false
      const before = await fs.stat(this.#file)
      if (before.size !== this.#durableBytes) throw new ProvenanceJournalChangedError()
      readCheckpoint(this.#entries)
      const entries: JournalEntry[] = []
      let written = 0
      for await (const entry of compactEntries(this.#entries, manifest, slices)) {
        entries.push(entry)
        written += serializeEntry(entry).length
      }
      await reserve?.(entries, written)
      const source = async function* () {
        for (const entry of entries) { await slices.step(); yield entry }
      }
      this.#durableBytes = await rewriteJournal(this.#file, before, source())
      this.#entries = entries
      this.#sequence = entries.length
      this.#ids = new Map(entries.map((entry) => [keyOf(entry.kind, entry.value), entry.seq]))
      this.#generation += 1
      return true
    } catch (error) { throw normalizeStorageError(error) }
  }

  async flush(): Promise<void> {
    await this.#tail
    if (this.#failed) throw this.#failed
    if (this.#broken) throw new Error('provenance-journal-damaged')
  }
}

/** Only a final manifest acknowledges its preceding parts. A torn attempt is inert. */
export const writeCheckpoint = (journal: ProvenanceJournal, value: unknown): Promise<void> => {
  // The in-memory reader fixtures implement only append; the durable journal
  // owns the whole transaction so no compaction can renumber in-flight parts.
  return journal.checkpoint ? journal.checkpoint(value) : checkpointParts(journal.append.bind(journal), value)
}

const checkpointParts = async (
  append: (kind: JournalKind, value: unknown) => Promise<number>, value: unknown,
): Promise<void> => {
  if (!checkpointValue(value)) throw new Error('provenance-invalid-checkpoint')
  const bytes = JSON.stringify(value)
  const hash = digest(value)
  const parts: number[] = []
  for (let offset = 0; offset < bytes.length; offset += 12000) {
    const id = digest(['part', hash, offset])
    parts.push(await append('cursor', { id, type: 'part', bytes: bytes.slice(offset, offset + 12000) }))
  }
  await append('cursor', { id: digest(['checkpoint', hash]), type: 'checkpoint', parts, hash })
}

/**
 * The latest completed checkpoint. Each one names its own parts, so the ones
 * before it were superseded and are not read again: a journal holds one for
 * every scan that found something, and reading them all each time cost more
 * with every scan since the desk started.
 */
export const readCheckpoint = (entries: readonly JournalEntry[]): unknown | null => {
  let bySequence: Map<number, JournalEntry> | null = null
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const entry = entries[at]!
    if (entry.kind !== 'cursor' || !object(entry.value) || entry.value.type !== 'checkpoint') continue
    const bytes = (entry.value.parts as number[]).map((seq) => {
      let part = entries[seq - 1]
      if (part?.seq !== seq) {
        bySequence ??= new Map(entries.map((entry) => [entry.seq, entry]))
        part = bySequence.get(seq)
      }
      if (!part || part.seq >= entry.seq || part.kind !== 'cursor' ||
        !object(part.value) || part.value.type !== 'part') throw new Error('provenance-invalid-checkpoint')
      return part.value.bytes as string
    }).join('')
    const value: unknown = JSON.parse(bytes)
    if (!checkpointValue(value) || digest(value) !== entry.value.hash) throw new Error('provenance-invalid-checkpoint')
    return value
  }
  return null
}
