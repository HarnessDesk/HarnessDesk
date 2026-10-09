import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
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

export class ProvenanceJournal {
  readonly #file: string
  #entries: JournalEntry[] = []
  #ids = new Map<string, number>()
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
    let pending = Buffer.alloc(0)
    const slices = new WorkSlices(options)
    // On open, keep historical observations and only the checkpoint in force
    // in memory. Offsets let a later manifest reuse an earlier part without
    // retaining all superseded checkpoint bytes in the heap.
    const cursors = new Map<number, JournalEntry>()
    const positions = new Map<number, { position: number; length: number }>()
    let position = 0
    let removed = 0
    try {
      for await (const bytes of createReadStream(this.#file, { highWaterMark: 16 * 1024 })) {
        pending = Buffer.concat([pending, bytes as Buffer])
        let end: number
        while ((end = pending.indexOf(10)) >= 0) {
          if (end + 1 > JOURNAL_LIMIT) throw new Error('journal-line-limit')
          const raw = pending.subarray(0, end)
          const line: unknown = JSON.parse(raw.toString('utf8'))
          if (!Buffer.from(raw.toString('utf8')).equals(raw) || !object(line)) throw new Error('journal-shape')
          const { version, seq, kind, value, checksum } = line
          if (version !== 1 || seq !== this.#sequence + 1 || !kinds.has(kind as JournalKind) ||
            !validValue(kind as JournalKind, value, this.#sequence) ||
            checksum !== digest({ version, seq, kind, value })) throw new Error('journal-damaged')
          const entry = { seq, kind, value } as JournalEntry
          this.#sequence = entry.seq
          if (this.#compactOnOpen && entry.kind === 'cursor') {
            positions.set(entry.seq, { position, length: end + 1 })
            cursors.set(entry.seq, entry)
            if ((value as { type: string }).type === 'checkpoint') {
              const keep = new Set([entry.seq, ...(value as { parts: number[] }).parts])
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
              for (const seq of cursors.keys()) if (!keep.has(seq)) { cursors.delete(seq); removed += 1 }
            }
          } else {
            this.#entries.push(entry)
            this.#ids.set(keyOf(entry.kind, value), entry.seq)
          }
          position += end + 1
          pending = pending.subarray(end + 1)
          await slices.step()
        }
        if (pending.length >= JOURNAL_LIMIT) throw new Error('journal-line-limit')
      }
      if (pending.length) throw new Error('journal-torn-tail')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#broken = true
    }
    if (this.#compactOnOpen) {
      this.#entries = [...this.#entries, ...cursors.values()].sort((a, b) => a.seq - b.seq)
      this.#ids = new Map(this.#entries.map((entry) => [keyOf(entry.kind, entry.value), entry.seq]))
      if (!this.#broken) await this.#compactLoaded(true, removed > 0)
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
      return this.#appendLoaded(kind, saved)
    })
    this.#tail = next.then(() => {}, () => {})
    return next
  }

  async #appendLoaded(kind: JournalKind, saved: unknown): Promise<number> {
    if (this.#broken) throw new Error('provenance-journal-damaged')
    if (this.#failed) throw this.#failed
    if (!validValue(kind, saved, this.#entries.length)) throw new Error('provenance-invalid-record')
    const key = keyOf(kind, saved)
    const existing = this.#ids.get(key)
    if (existing !== undefined) return existing
    const body = { version: 1, seq: this.#sequence + 1, kind, value: saved }
    const bytes = Buffer.from(`${JSON.stringify({ ...body, checksum: digest(body) })}\n`)
    if (bytes.length > JOURNAL_LIMIT) throw new Error('provenance-line-limit')
    try {
      await fs.mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
      const file = await fs.open(this.#file, 'a', 0o600)
      try {
        if ((await file.write(bytes)).bytesWritten !== bytes.length) throw new Error('provenance-short-write')
        await file.sync()
      } finally {
        await file.close()
      }
    } catch (error) {
      this.#failed = error instanceof Error ? error : new Error('provenance-write-failed')
      throw this.#failed
    }
    this.#entries.push({ seq: body.seq, kind, value: saved })
    this.#sequence = body.seq
    this.#ids.set(key, body.seq)
    return body.seq
  }

  /** Parts, manifest and replacement share one queue slot, including concurrent callers. */
  checkpoint(value: unknown): Promise<void> {
    const saved = structuredClone(value)
    const next = this.#tail.then(async () => {
      await this.#loadOnce()
      await checkpointParts((kind, value) => this.#appendLoaded(kind, value), saved)
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

  async #compactLoaded(force: boolean, removedOnOpen = false): Promise<boolean> {
    if (this.#broken) throw new Error('provenance-journal-damaged')
    if (this.#failed) throw this.#failed
    const manifest = this.#entries.findLast((entry) => entry.kind === 'cursor' &&
      object(entry.value) && entry.value.type === 'checkpoint')
    // Live: every ref, commit, range, link (including older decision ids used
    // by amend proofs), gap and restored record is read by reconcile or backup.
    // Only the latest complete checkpoint and its parts remain live cursors.
    // Orphan parts and superseded manifests/parts have no reader.
    const keep = new Set(manifest ? [manifest.seq, ...(manifest.value as { parts: number[] }).parts] : [])
    const retained: JournalEntry[] = []
    const slices = new WorkSlices()
    let obsolete = 0
    let bytes = 0
    for (const entry of this.#entries) {
      await slices.step()
      if (entry.kind !== 'cursor' || keep.has(entry.seq)) retained.push(entry)
      else { obsolete += 1; bytes += Buffer.byteLength(JSON.stringify(entry.value)) }
    }
    if (!obsolete && !removedOnOpen) return false
    if (!force && obsolete * 2 <= this.#entries.length && bytes < 32 * 1024 * 1024) return false
    // Validate before writing anything; a bad latest manifest must not erase
    // the original bytes or fall back to a superseded decision checkpoint.
    readCheckpoint(this.#entries)
    const sequence = new Map(retained.map((entry, at) => [entry.seq, at + 1]))
    const entries: JournalEntry[] = []
    const temporary = `${this.#file}.compact-${randomUUID()}`
    try {
      const file = await fs.open(temporary, 'wx', 0o600)
      try {
        for (const entry of retained) {
          await slices.step()
          const value = entry === manifest ? { ...(entry.value as object), parts: (entry.value as { parts: number[] }).parts.map((seq) => sequence.get(seq)!) } : entry.value
          const saved = { seq: entries.length + 1, kind: entry.kind, value }
          const body = { version: 1, ...saved }
          const bytes = Buffer.from(`${JSON.stringify({ ...body, checksum: digest(body) })}\n`)
          if ((await file.write(bytes)).bytesWritten !== bytes.length) throw new Error('provenance-short-write')
          entries.push(saved)
        }
        await file.sync()
      } finally { await file.close() }
      await fs.rename(temporary, this.#file)
      this.#entries = entries
      this.#sequence = entries.length
      this.#ids = new Map(entries.map((entry) => [keyOf(entry.kind, entry.value), entry.seq]))
      this.#generation += 1
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
    return true
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
