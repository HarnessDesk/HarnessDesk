import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LEAD_JOURNAL_BYTES, initialLeadState, parseLeadJournalRecord, prepareLeadJournalRecord, reduceLeadRecord, leadCheckpoint, parseLeadCheckpoint,
  type LeadJournalRecord, type LeadJournalStorage, type LeadState, type LeadJournalSecurity, type LeadJournalCheckpoint } from '@harnessdesk/lead'

const zero = '0'.repeat(64)
const SNAPSHOT_BYTES = 12 * 1024 * 1024
const NORMAL_STATE_BYTES = 8 * 1024 * 1024
const NORMAL_BYTES = 48 * 1024 * 1024 // Leave 16 MiB for Stop, terminal decisions and reconciliation.
const TOTAL_BYTES = 64 * 1024 * 1024
const criticalRecord = (record: LeadJournalRecord): boolean =>
  record.type === 'budget' && !['initialize', 'reserve', 'round', 'start'].includes(record.event.type) ||
  ['management', 'invalidate-results', 'restore-result', 'resume', 'start-resolution', 'stop', 'stop-effects-done', 'card-decision', 'reconciliation', 'recovery-report', 'recovery-block', 'recovery-resolved', 'decision', 'dispatch-start', 'result'].includes(record.type) ||
  record.type === 'attempt' && (record.kind === 'read' || record.method === 'flow/execution/stop' || record.method === 'team/intent' && record.action === 'abandon')
const checksum = (record: LeadJournalRecord | LeadJournalCheckpoint, previous: string) => createHash('sha256').update(JSON.stringify({ record, previous })).digest('hex')
const syncDirectory = async (path: string) => { const file = await fs.open(path, 'r'); try { await file.sync() } finally { await file.close() } }
const hashFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
interface Segment { readonly name: string; readonly hash: string; readonly previous: string; readonly checksum: string }
interface Anchor { readonly seq: number; readonly hash: string; readonly segments: string }
const segmentChecksum = (segment: Pick<Segment, 'name' | 'hash' | 'previous'>) =>
  createHash('sha256').update(JSON.stringify({ name: segment.name, hash: segment.hash, previous: segment.previous })).digest('hex')
interface Rotation { readonly archive: string; readonly temporary: string; readonly archiveHash: string; readonly hash: string; readonly seq: number }
export interface LeadJournalReport {
  readonly truncatedTail: boolean; readonly quarantine: string | null; readonly discardedBytes: number
  readonly historicalQuarantines: readonly string[]
}
/** The lock database owns an OS-released exclusive lease. Its companion metadata database
 * commits the synced chain head and rotation intent while the lease remains held.
 * Sealed segments retain the append-only audit; checkpoints bound active replay. */
export class LeadFileJournal implements LeadJournalStorage {
  #records: LeadJournalRecord[] = []
  #state: LeadState = initialLeadState()
  #base: LeadState | null = null
  #checksum = zero
  #segmentHead = zero
  #sizes = new WeakMap<object, number>()
  #bytes = 0
  #tail: Promise<unknown> = Promise.resolve()
  #failed = false
  #closing = false
  #closed = false
  #report: LeadJournalReport = { truncatedTail: false, quarantine: null, discardedBytes: 0, historicalQuarantines: [] }
  private constructor(private readonly directory: string, private readonly file: string, private handle: FileHandle,
    private readonly lease: DatabaseSync, private readonly metadata: DatabaseSync, private readonly security: LeadJournalSecurity) {}
  get report(): LeadJournalReport { return structuredClone(this.#report) }
  journalSecurity(): LeadJournalSecurity { return { ...this.security, canaries: [...(this.security.canaries ?? [])] } }
  checkpoint(): LeadState | null { return structuredClone(this.#base) }
  #get<T>(key: string, fallback: T): T {
    const row = this.metadata.prepare('SELECT value FROM journal WHERE key = ?').get(key) as { value: string } | undefined
    return row ? JSON.parse(row.value) as T : fallback
  }
  #put(key: string, value: unknown): void { this.metadata.prepare('INSERT OR REPLACE INTO journal VALUES (?, ?)').run(key, JSON.stringify(value)) }
  #anchor(): void { this.#put('head', { seq: this.#state.seq, hash: this.#checksum, segments: this.#segmentHead }) }
  #valueBytes(value: unknown): number {
    if (value !== null && typeof value === 'object') {
      const cached = this.#sizes.get(value)
      if (cached !== undefined) return cached
      const size = Buffer.byteLength(JSON.stringify(value)); this.#sizes.set(value, size); return size
    }
    return Buffer.byteLength(JSON.stringify(value))
  }
  #stateBytes(state: LeadState): number {
    // Immutable reducer fields keep their cached sizes. The bounded Map changes on
    // each attempt, but only its changed attempt object needs serialization.
    let bytes = 512 // Checkpoint envelope, keys, punctuation and numeric growth.
    for (const [key, value] of Object.entries(state)) {
      if (key === 'attempts') {
        bytes += 2
        for (const [id, attempt] of state.attempts) bytes += this.#valueBytes(id) + this.#valueBytes(attempt) + 4
      } else bytes += this.#valueBytes(key) + this.#valueBytes(value) + 2
    }
    return bytes
  }
  #segments(): Segment[] {
    const segments = this.#get<Segment[]>('segments', [])
    if (!Array.isArray(segments)) throw new Error('lead-journal-segment-chain')
    let previous = zero
    for (const segment of segments) {
      if (!segment || Object.keys(segment).sort().join() !== ['name', 'hash', 'previous', 'checksum'].sort().join() ||
        !/^[A-Za-z0-9_.-]+$/.test(segment.name) || !/^[a-f0-9]{64}$/.test(segment.hash) ||
        segment.previous !== previous || segment.checksum !== segmentChecksum(segment)) throw new Error('lead-journal-segment-chain')
      previous = segment.checksum
    }
    this.#segmentHead = previous
    return segments
  }
  async #finishRotation(rotation: Rotation): Promise<void> {
    const archive = join(this.directory, rotation.archive), temporary = join(this.directory, rotation.temporary)
    if (await hashFile(archive) !== rotation.archiveHash) throw new Error('lead-journal-archive-corruption')
    // Atomic replacement leaves either the old complete file or the new complete checkpoint.
    const current = await hashFile(this.file)
    const target = this.#get<string>('rotation-file-hash', '')
    if (current !== target) {
      if (current !== rotation.archiveHash || await hashFile(temporary) !== target) throw new Error('lead-journal-rotation-corruption')
      await fs.rename(temporary, this.file); await syncDirectory(this.directory)
    }
    await this.handle.close()
    this.handle = await fs.open(this.file, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW)
    const segments = this.#segments()
    const entry = { name: rotation.archive, hash: rotation.archiveHash, previous: this.#segmentHead }
    const segment = { ...entry, checksum: segmentChecksum(entry) }
    this.metadata.exec('BEGIN IMMEDIATE')
    try {
      this.#put('segments', [...segments, segment])
      this.#put('head', { seq: rotation.seq, hash: rotation.hash, segments: segment.checksum }); this.#put('rotation', null)
      this.metadata.exec('COMMIT'); this.#segmentHead = segment.checksum
    } catch (error) { this.metadata.exec('ROLLBACK'); throw error }
  }
  async #rotate(): Promise<void> {
    if (this.#state.seq === 0 || this.#records.length === 0) return
    const record = leadCheckpoint(this.#state, this.#checksum)
    const hash = checksum(record, record.head), bytes = Buffer.from(JSON.stringify({ record, previous: record.head, checksum: hash }) + '\n')
    if (bytes.length > SNAPSHOT_BYTES + LEAD_JOURNAL_BYTES) throw new Error('lead-journal-checkpoint-limit')
    const suffix = randomUUID(), basename = this.file.slice(this.directory.length + 1)
    const archive = `${basename}.sealed-${suffix}`, temporary = `${basename}.checkpoint-${suffix}`
    const target = await fs.open(join(this.directory, temporary), 'wx', 0o600)
    try { await target.writeFile(bytes); await target.sync() } finally { await target.close() }
    await fs.link(this.file, join(this.directory, archive))
    await syncDirectory(this.directory)
    const rotation: Rotation = { archive, temporary, archiveHash: await hashFile(this.file), hash, seq: this.#state.seq }
    this.metadata.exec('BEGIN IMMEDIATE')
    try {
      this.#put('rotation-file-hash', createHash('sha256').update(bytes).digest('hex')); this.#put('rotation', rotation)
      this.metadata.exec('COMMIT')
    } catch (error) { this.metadata.exec('ROLLBACK'); throw error }
    await this.#finishRotation(rotation)
    this.#base = structuredClone(this.#state); this.#records = []; this.#checksum = hash; this.#bytes = bytes.length
  }
  private async load(): Promise<void> {
    const basename = this.file.slice(this.directory.length + 1)
    const files = await fs.readdir(this.directory)
    const format = this.#get<number | null>('format', null)
    if (format !== null && format !== 2) throw new Error('lead-journal-format')
    let anchor = this.#get<Anchor | null>('head', null)
    const hasHistory = (await this.handle.stat()).size > 0 || files.some(name => name.startsWith(`${basename}.sealed-`) || name.startsWith(`${basename}.checkpoint-`))
    if (anchor === null) {
      if (hasHistory) throw new Error('lead-journal-missing-anchor')
      anchor = { seq: 0, hash: zero, segments: zero }
    }
    // Round-1 journals already have a durable record anchor. Upgrade their
    // unchained manifest only after a one-time verification of every sealed file.
    // Missing anchors never take this compatibility path.
    if (!Object.hasOwn(anchor, 'segments')) {
      if (format === 2) throw new Error('lead-journal-format-downgrade')
      if (Object.keys(anchor).sort().join() !== ['seq', 'hash'].sort().join() || !Number.isSafeInteger(anchor.seq) || anchor.seq < 0 || !/^[a-f0-9]{64}$/.test(anchor.hash))
        throw new Error('lead-journal-invalid-anchor')
      const legacy = this.#get<{ name: string; hash: string }[]>('segments', [])
      if (!Array.isArray(legacy)) throw new Error('lead-journal-segment-chain')
      let previous = zero
      const upgraded: Segment[] = []
      for (const item of legacy) {
        if (!item || Object.keys(item).sort().join() !== ['name', 'hash'].sort().join() || !/^[A-Za-z0-9_.-]+$/.test(item.name) ||
          !/^[a-f0-9]{64}$/.test(item.hash) || await hashFile(join(this.directory, item.name)) !== item.hash) throw new Error('lead-journal-archive-corruption')
        const segment = { ...item, previous, checksum: segmentChecksum({ ...item, previous }) }
        upgraded.push(segment); previous = segment.checksum
      }
      anchor = { ...anchor, segments: previous }
      this.metadata.exec('BEGIN IMMEDIATE')
      try { this.#put('segments', upgraded); this.#put('head', anchor); this.#put('format', 2); this.metadata.exec('COMMIT') }
      catch (error) { this.metadata.exec('ROLLBACK'); throw error }
    }
    if (!anchor || Object.keys(anchor).sort().join() !== ['seq', 'hash', 'segments'].sort().join() ||
      !Number.isSafeInteger(anchor.seq) || anchor.seq < 0 || !/^[a-f0-9]{64}$/.test(anchor.hash) || !/^[a-f0-9]{64}$/.test(anchor.segments))
      throw new Error('lead-journal-invalid-anchor')
    let segments = this.#segments()
    if (anchor.seq === 0 && segments.length > 0) throw new Error('lead-journal-invalid-genesis')
    if (this.#segmentHead !== anchor.segments) throw new Error('lead-journal-segment-anchor')
    const rotation = this.#get<Rotation | null>('rotation', null)
    if (rotation) {
      await this.#finishRotation(rotation)
      anchor = this.#get<Anchor>('head', anchor); segments = this.#segments()
      if (this.#segmentHead !== anchor.segments) throw new Error('lead-journal-segment-anchor')
    }
    // Retain sealed audit segments until a separate retention policy is defined.
    // Their hashes form the metadata chain anchored beside the synced record head.
    // Reopen reads only the newest sealed content; older hashes remain available for audit.
    const newest = segments.at(-1)
    if (newest && await hashFile(join(this.directory, newest.name)) !== newest.hash) throw new Error('lead-journal-archive-corruption')
    const listed = new Set(segments.map(segment => segment.name))
    let removed = false
    for (const name of await fs.readdir(this.directory)) {
      if (name.startsWith(`${basename}.checkpoint-`) || name.startsWith(`${basename}.sealed-`) && !listed.has(name)) {
        await fs.unlink(join(this.directory, name)); removed = true
      }
    }
    if (removed) await syncDirectory(this.directory)
    let reached = anchor.seq === 0 && anchor.hash === zero
    const accept = (bytes: Buffer): void => {
      const text = bytes.toString('utf8')
      if (!Buffer.from(text).equals(bytes)) throw new Error('lead-journal-encoding')
      const source = JSON.parse(text) as { record: unknown; previous: unknown; checksum: unknown }
      if (!source || Object.keys(source).sort().join() !== ['record', 'previous', 'checksum'].sort().join()) throw new Error('lead-journal-frame')
      if ((source.record as { type?: unknown })?.type === 'checkpoint') {
        if (anchor.seq === 0 || segments.length === 0) throw new Error('lead-journal-checkpoint-anchor-required')
        if (this.#state.seq !== 0 || this.#base !== null) throw new Error('lead-journal-checkpoint-position')
        const { checkpoint, state } = parseLeadCheckpoint(source.record)
        if (source.previous !== checkpoint.head || source.checksum !== checksum(checkpoint, checkpoint.head)) throw new Error('lead-journal-checkpoint-checksum')
        this.#state = state; this.#base = structuredClone(state); this.#checksum = source.checksum as string
      } else {
        if (bytes.length > LEAD_JOURNAL_BYTES + 256) throw new Error('lead-journal-line-limit')
        const record = parseLeadJournalRecord(source.record)
        const hash = checksum(record, this.#checksum)
        if (source.previous !== this.#checksum || source.checksum !== hash) throw new Error('lead-journal-checksum')
        this.#state = reduceLeadRecord(this.#state, record)
        this.#records.push(record); this.#checksum = hash
      }
      if (this.#state.seq === anchor.seq && this.#checksum === anchor.hash) reached = true
    }
    let pending = Buffer.alloc(0), offset = 0
    for await (const chunk of createReadStream(this.file, { highWaterMark: 64 * 1024 })) {
      pending = Buffer.concat([pending, chunk as Buffer])
      let end: number
      while ((end = pending.indexOf(10)) >= 0) {
        if (end > SNAPSHOT_BYTES + LEAD_JOURNAL_BYTES) throw new Error('lead-journal-line-limit')
        accept(pending.subarray(0, end)); offset += end + 1
        if (offset > TOTAL_BYTES) throw new Error('lead-journal-total-limit')
        pending = pending.subarray(end + 1)
      }
      if (pending.length > SNAPSHOT_BYTES + LEAD_JOURNAL_BYTES) throw new Error('lead-journal-line-limit')
    }
    this.#report = { ...this.#report, historicalQuarantines: (await fs.readdir(this.directory)).filter(name => name.startsWith(`${basename}.truncated-`)).sort().map(name => join(this.directory, name)) }
    if (pending.length) {
      // Only a syntactically torn suffix can be discarded. Complete but corrupt frames fail closed.
      let complete = false
      try { JSON.parse(pending.toString('utf8')); complete = true } catch { /* Torn bytes. */ }
      if (complete) {
        accept(pending)
        await this.handle.writeFile('\n'); await this.handle.sync(); offset += pending.length + 1
      } else {
        if (!reached) throw new Error('lead-journal-lost-head')
        this.#put('blocked', true)
        const quarantine = `${this.file}.truncated-${randomUUID()}`, copy = await fs.open(quarantine, 'wx', 0o600)
        try { await copy.writeFile(pending); await copy.sync() } finally { await copy.close() }
        await syncDirectory(this.directory); await this.handle.truncate(offset); await this.handle.sync()
        this.#report = { ...this.#report, truncatedTail: true, quarantine, discardedBytes: pending.length }
      }
    }
    if (!reached) throw new Error('lead-journal-lost-head')
    this.#bytes = offset; this.#anchor(); this.#put('format', 2)
    if (this.#get('blocked', false) && !this.#state.recoveryBlocked) await this.append({ version: 1, seq: this.#state.seq + 1, type: 'recovery-block' })
    if (this.#records.length >= 1024 || this.#bytes > NORMAL_BYTES) await this.#rotate()
  }
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new Error('lead-journal-closed'))
    const next = this.#tail.then(async () => { if (this.#failed) throw new Error('lead-journal-failed'); return work() })
    this.#tail = next.catch(() => {})
    return next
  }
  read(): Promise<readonly LeadJournalRecord[]> { return this.#enqueue(async () => structuredClone(this.#records)) }
  prepare(value: unknown, previous: LeadState = this.#state): LeadJournalRecord {
    const record = prepareLeadJournalRecord(value, this.security)
    const state = reduceLeadRecord(previous, record)
    // Domain/card growth is refused before touching storage; existing terminal state always fits.
    if (!criticalRecord(record) && this.#stateBytes(state) > NORMAL_STATE_BYTES) throw new Error('lead-journal-state-limit')
    return record
  }
  append(value: LeadJournalRecord): Promise<void> {
    return this.#enqueue(async () => {
      const record = this.prepare(value), state = reduceLeadRecord(this.#state, record)
      const critical = criticalRecord(record)
      if (this.#bytes > NORMAL_BYTES || !critical && this.#bytes + LEAD_JOURNAL_BYTES + 256 > NORMAL_BYTES || this.#records.length >= 1024) {
        try { await this.#rotate() } catch { this.#failed = true; throw new Error('lead-journal-checkpoint-write-failed') }
      }
      const hash = checksum(record, this.#checksum), bytes = Buffer.from(JSON.stringify({ record, previous: this.#checksum, checksum: hash }) + '\n')
      if (this.#bytes + bytes.length > (critical ? TOTAL_BYTES : NORMAL_BYTES)) throw new Error('lead-journal-total-limit')
      try {
        await this.handle.writeFile(bytes); await this.handle.sync()
        this.#records.push(record); this.#state = state; this.#checksum = hash; this.#bytes += bytes.length
        this.#anchor()
        if (record.type === 'recovery-resolved') this.#put('blocked', false)
      } catch { this.#failed = true; throw new Error('lead-journal-write-failed') }
    })
  }
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closing = true; await this.#tail
    if (this.#closed) return
    this.#closed = true
    try { await this.handle.close() } finally { try { this.metadata.close() } finally { try { this.lease.exec('ROLLBACK') } finally { this.lease.close() } } }
  }
  static async open(stateDirectory: string, thread: string, security: LeadJournalSecurity = {}): Promise<LeadFileJournal> {
    if (!isAbsolute(stateDirectory) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(thread)) throw new Error('lead-journal-location')
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    const home = await fs.realpath(stateDirectory), directory = join(home, 'lead')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('lead-journal-directory-link')
    await fs.chmod(directory, 0o700)
    const file = join(directory, `${thread}.ndjson`), lock = join(directory, `${thread}.lease.sqlite`), meta = join(directory, `${thread}.writer.sqlite`)
    for (const path of [lock, meta]) {
      try { if ((await fs.lstat(path)).isSymbolicLink()) throw new Error('lead-journal-lease-link') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const lease = new DatabaseSync(lock)
    let handle: FileHandle | null = null, metadata: DatabaseSync | null = null, journal: LeadFileJournal | null = null
    try {
      lease.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE')
      await fs.chmod(lock, 0o600)
      metadata = new DatabaseSync(meta)
      metadata.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS journal (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      await fs.chmod(meta, 0o600)
      handle = await fs.open(file, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
      await handle.chmod(0o600); await handle.sync(); await syncDirectory(directory); await syncDirectory(home)
      journal = new LeadFileJournal(directory, file, handle, lease, metadata, { ...security, digestContract: security.digestContract ?? (contract => {
        const { digest: _digest, ...body } = contract; return createHash('sha256').update(JSON.stringify(body)).digest('hex')
      }) })
      await journal.load()
      return journal
    } catch {
      if (journal) await journal.close()
      else { await handle?.close(); metadata?.close(); lease.close() }
      throw new Error('lead-journal-open-refused')
    }
  }
}
export const openLeadFileJournal = (stateDirectory: string, thread: string, security: LeadJournalSecurity = {}): Promise<LeadFileJournal> => LeadFileJournal.open(stateDirectory, thread, security)
