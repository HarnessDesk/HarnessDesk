import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { setImmediate } from 'node:timers/promises'

export type JournalKind = 'ref' | 'commit' | 'range' | 'link' | 'cursor' | 'gap'
export interface JournalEntry {
  readonly seq: number
  readonly kind: JournalKind
  readonly value: unknown
}
export interface JournalRead {
  readonly entries: readonly JournalEntry[]
  readonly broken: boolean
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
  strings(value.rangeKeys) && strings(value.rangePending) && array(value.baseline, sha)

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
  #ids = new Set<string>()
  #load: Promise<void> | null = null
  #tail: Promise<void> = Promise.resolve()
  #broken = false
  #failed: Error | null = null

  constructor(file: string) {
    this.#file = file
  }

  async #loadOnce(): Promise<void> {
    this.#load ??= this.#stream()
    await this.#load
  }

  async #stream(): Promise<void> {
    let pending = Buffer.alloc(0)
    let count = 0
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
          if (version !== 1 || seq !== this.#entries.length + 1 || !kinds.has(kind as JournalKind) ||
            !validValue(kind as JournalKind, value, this.#entries.length) ||
            checksum !== digest({ version, seq, kind, value })) throw new Error('journal-damaged')
          const entry = { seq, kind, value } as JournalEntry
          this.#entries.push(entry)
          this.#ids.add(keyOf(entry.kind, value))
          pending = pending.subarray(end + 1)
          if (++count % 200 === 0) await setImmediate()
        }
        if (pending.length >= JOURNAL_LIMIT) throw new Error('journal-line-limit')
      }
      if (pending.length) throw new Error('journal-torn-tail')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#broken = true
    }
  }

  async read(): Promise<JournalRead> {
    await this.#loadOnce()
    await this.#tail
    return { entries: structuredClone(this.#entries), broken: this.#broken }
  }

  append(kind: JournalKind, value: unknown): Promise<void> {
    // Snapshot now; the caller cannot change a queued record before its checksum.
    const saved = structuredClone(value)
    const next = this.#tail.then(async () => {
      await this.#loadOnce()
      if (this.#broken) throw new Error('provenance-journal-damaged')
      if (this.#failed) throw this.#failed
      if (!validValue(kind, saved, this.#entries.length)) throw new Error('provenance-invalid-record')
      const key = keyOf(kind, saved)
      if (this.#ids.has(key)) return
      const body = { version: 1, seq: this.#entries.length + 1, kind, value: saved }
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
      this.#ids.add(key)
    })
    this.#tail = next.catch(() => {})
    return next
  }

  async flush(): Promise<void> {
    await this.#tail
    if (this.#failed) throw this.#failed
    if (this.#broken) throw new Error('provenance-journal-damaged')
  }
}

/** Only a final manifest acknowledges its preceding parts. A torn attempt is inert. */
export const writeCheckpoint = async (journal: ProvenanceJournal, value: unknown): Promise<void> => {
  if (!checkpointValue(value)) throw new Error('provenance-invalid-checkpoint')
  const bytes = JSON.stringify(value)
  const hash = digest(value)
  const ids: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 12000) {
    const id = digest(['part', hash, offset])
    await journal.append('cursor', { id, type: 'part', bytes: bytes.slice(offset, offset + 12000) })
    ids.push(id)
  }
  const entries = (await journal.read()).entries
  const parts = ids.map((id) => entries.find((entry) => entry.kind === 'cursor' &&
    (entry.value as { id: string }).id === id)!.seq)
  await journal.append('cursor', { id: digest(['checkpoint', hash]), type: 'checkpoint', parts, hash })
}

export const readCheckpoint = (entries: readonly JournalEntry[]): unknown | null => {
  let latest: unknown = null
  for (const entry of entries) {
    if (entry.kind !== 'cursor' || !object(entry.value) || entry.value.type !== 'checkpoint') continue
    const bytes = (entry.value.parts as number[]).map((seq) => {
      const part = entries[seq - 1]
      if (!part || part.seq >= entry.seq || part.kind !== 'cursor' ||
        !object(part.value) || part.value.type !== 'part') throw new Error('provenance-invalid-checkpoint')
      return part.value.bytes as string
    }).join('')
    const value: unknown = JSON.parse(bytes)
    if (!checkpointValue(value) || digest(value) !== entry.value.hash) throw new Error('provenance-invalid-checkpoint')
    latest = value
  }
  return latest
}
