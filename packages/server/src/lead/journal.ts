import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LEAD_JOURNAL_BYTES, initialLeadState, parseLeadJournalRecord, reduceLeadRecord,
  type LeadJournalRecord, type LeadJournalStorage, type LeadState } from '@harnessdesk/lead'

const zero = '0'.repeat(64)
const checksum = (record: LeadJournalRecord, previous: string) => createHash('sha256').update(JSON.stringify({ record, previous })).digest('hex')
const syncDirectory = async (path: string) => { const file = await fs.open(path, 'r'); try { await file.sync() } finally { await file.close() } }
export interface LeadJournalReport { readonly truncatedTail: boolean; readonly quarantine: string | null; readonly discardedBytes: number }

/** NDJSON remains append-only. A SQLite exclusive transaction is only the writer lease:
 * it is released by the OS on death, so recovery needs no unsafe stale-PID lock removal.
 * The caller must pass the host's state directory; there is deliberately no home default. */
export class LeadFileJournal implements LeadJournalStorage {
  #records: LeadJournalRecord[] = []
  #state: LeadState = initialLeadState()
  #checksum = zero
  #bytes = 0
  #tail: Promise<unknown> = Promise.resolve()
  #failed = false
  #closing = false
  #closed = false
  #report: LeadJournalReport = { truncatedTail: false, quarantine: null, discardedBytes: 0 }
  private constructor(private readonly directory: string, private readonly file: string, private readonly handle: FileHandle, private readonly lease: DatabaseSync) {}
  get report(): LeadJournalReport { return { ...this.#report } }
  private async load(): Promise<void> {
    let pending = Buffer.alloc(0), offset = 0
    for await (const chunk of createReadStream(this.file, { highWaterMark: 16 * 1024 })) {
      pending = Buffer.concat([pending, chunk as Buffer])
      let end: number
      while ((end = pending.indexOf(10)) >= 0) {
        if (end > LEAD_JOURNAL_BYTES + 256) throw new Error('lead-journal-line-limit')
        const bytes = pending.subarray(0, end)
        const text = bytes.toString('utf8')
        if (!Buffer.from(text).equals(bytes)) throw new Error('lead-journal-encoding')
        const frame: unknown = JSON.parse(text)
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('lead-journal-frame')
        const source = frame as Record<string, unknown>
        if (Object.keys(source).length !== 3 || !Object.hasOwn(source, 'record') || !Object.hasOwn(source, 'previous') || !Object.hasOwn(source, 'checksum'))
          throw new Error('lead-journal-frame-fields')
        const record = parseLeadJournalRecord(source.record)
        const hash = checksum(record, this.#checksum)
        if (source.previous !== this.#checksum || source.checksum !== hash) throw new Error('lead-journal-checksum')
        this.#state = reduceLeadRecord(this.#state, record)
        this.#records.push(record); this.#checksum = hash
        offset += end + 1
        if (offset > 64 * 1024 * 1024) throw new Error('lead-journal-total-limit')
        pending = pending.subarray(end + 1)
      }
      if (pending.length > LEAD_JOURNAL_BYTES + 256) throw new Error('lead-journal-line-limit')
    }
    this.#bytes = offset
    const basename = this.file.slice(this.directory.length + 1)
    const previous = (await fs.readdir(this.directory)).filter(name => name.startsWith(`${basename}.truncated-`)).sort()
    if (previous.length) this.#report = { truncatedTail: true, quarantine: join(this.directory, previous.at(-1)!), discardedBytes: 0 }
    if (pending.length) {
      const quarantine = `${this.file}.truncated-${randomUUID()}`
      const copy = await fs.open(quarantine, 'wx', 0o600)
      try { await copy.writeFile(pending); await copy.sync() } finally { await copy.close() }
      await syncDirectory(this.directory)
      await this.handle.truncate(offset)
      await this.handle.sync()
      this.#report = { truncatedTail: true, quarantine, discardedBytes: pending.length }
    }
  }
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new Error('lead-journal-closed'))
    const next = this.#tail.then(async () => {
      if (this.#failed) throw new Error('lead-journal-failed')
      try { return await work() } catch { this.#failed = true; throw new Error('lead-journal-write-or-validation-failed') }
    })
    this.#tail = next.catch(() => {})
    return next
  }
  read(): Promise<readonly LeadJournalRecord[]> { return this.#enqueue(async () => structuredClone(this.#records)) }
  append(value: LeadJournalRecord): Promise<void> {
    let record: LeadJournalRecord
    try { record = parseLeadJournalRecord(value) } catch { return Promise.reject(new Error('lead-journal-invalid-record')) }
    return this.#enqueue(async () => {
      const state = reduceLeadRecord(this.#state, record)
      const hash = checksum(record, this.#checksum)
      const bytes = Buffer.from(JSON.stringify({ record, previous: this.#checksum, checksum: hash }) + '\n')
      if (this.#bytes + bytes.length > 64 * 1024 * 1024) throw new Error('lead-journal-total-limit')
      await this.handle.writeFile(bytes)
      await this.handle.sync()
      this.#records.push(record); this.#state = state; this.#checksum = hash; this.#bytes += bytes.length
    })
  }
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closing = true
    await this.#tail
    if (this.#closed) return
    this.#closed = true
    try { await this.handle.close() } finally { try { this.lease.exec('ROLLBACK') } finally { this.lease.close() } }
  }

  static async open(stateDirectory: string, thread: string): Promise<LeadFileJournal> {
    if (!isAbsolute(stateDirectory) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(thread)) throw new Error('lead-journal-location')
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    const home = await fs.realpath(stateDirectory)
    const directory = join(home, 'lead')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('lead-journal-directory-link')
    await fs.chmod(directory, 0o700)
    const file = join(directory, `${thread}.ndjson`), lock = join(directory, `${thread}.writer.sqlite`)
    try { if ((await fs.lstat(lock)).isSymbolicLink()) throw new Error('lead-journal-lease-link') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const lease = new DatabaseSync(lock)
    let handle: FileHandle | null = null
    try {
      lease.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE')
      await fs.chmod(lock, 0o600)
      handle = await fs.open(file, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
      await handle.chmod(0o600)
      await handle.sync()
      await syncDirectory(directory)
      await syncDirectory(home)
      const journal = new LeadFileJournal(directory, file, handle, lease)
      await journal.load()
      return journal
    } catch {
      await handle?.close()
      lease.close()
      throw new Error('lead-journal-open-refused')
    }
  }
}

export const openLeadFileJournal = (stateDirectory: string, thread: string): Promise<LeadFileJournal> => LeadFileJournal.open(stateDirectory, thread)
