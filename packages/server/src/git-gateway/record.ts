import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface GitRequester {
  readonly kind: 'lead-goal' | 'session' | 'person'
  readonly id: string
  readonly seat?: { readonly label: string; readonly role: string | null; readonly round: number | null; readonly team: string | null } | null
  readonly conversation?: { readonly runtime: string; readonly sessionId: string; readonly title?: string } | null
}
const text = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0')
export const isGitRequester = (value: unknown): value is GitRequester => {
  if (!value || typeof value !== 'object') return false
  const requester = value as GitRequester
  if (!['lead-goal', 'session', 'person'].includes(requester.kind) || !text(requester.id) || !requester.id.trim()) return false
  const seat = requester.seat, conversation = requester.conversation
  return (seat == null || typeof seat === 'object' && text(seat.label) && !!seat.label.trim() &&
    (seat.role === null || text(seat.role)) && (seat.team === null || text(seat.team)) &&
    (seat.round === null || Number.isSafeInteger(seat.round) && seat.round >= 1)) &&
    (conversation == null || typeof conversation === 'object' && text(conversation.runtime) && !!conversation.runtime &&
      text(conversation.sessionId) && !!conversation.sessionId && (conversation.title === undefined || text(conversation.title)))
}
export type GitApproval = { readonly by: 'person' | 'standing' | 'ceiling' | 'steered'; readonly at?: number } | null
export interface GitRecordEntry {
  readonly id: string
  readonly prev: string | null
  readonly op: 'push' | 'pr.create' | 'pr.update' | 'pr.merge' | 'pr.comment' | 'pr.review' | 'issue.comment' | 'observed'
  readonly repository: string
  readonly branch?: string
  readonly number?: number
  readonly sha?: string
  readonly previousSha?: string | null
  readonly lease?: string | null
  readonly requester: GitRequester | { readonly kind: 'outside' }
  readonly approval: GitApproval
  readonly steeredFrom?: string
  readonly at: number
  readonly outcome: 'intent' | 'ok' | 'refused' | 'failed' | 'rejected'
  readonly reason?: string
}
export interface GitRecordQuery {
  readonly repository: string; readonly branch?: string; readonly number?: number
  readonly view?: 'all' | 'outside' | 'refused'; readonly limit: number; readonly before?: string
}
export type GitRecordVerification = ({ readonly ok: true } | { readonly ok: false; readonly line: number }) & { readonly damaged: number }
export const canonicalRepository = (repository: string): string => {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split('/').some(part => part === '.' || part === '..')) throw new Error('git-gateway-repository-invalid')
  return repository.toLowerCase()
}
export const validateRepository = (repository: string): void => { canonicalRepository(repository) }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
interface Line { readonly hash: string; readonly row?: GitRecordEntry }
interface Segment { readonly name: string; readonly signature: string; readonly size: number; readonly lines: readonly Line[] }
interface Snapshot {
  readonly rows: GitRecordEntry[]; readonly last: string | null; readonly count: number; readonly segments: Segment[]
  readonly verification: GitRecordVerification; readonly branches: Map<string, GitRecordEntry[]>
}
export interface SucceededPushQuery { readonly repository: string; readonly branch: string; readonly sha: string; readonly requester: GitRequester }

/** Host-only journal. Segments share one chain; a separately persisted anchor
 * commits its tail and physical line count. Reads cache parsed segments and a
 * branch index. A changed segment is rechecked in full; sealed history is cached.
 * Damaged history is inspectable, but never authorizes a write or attribution. */
export class GitRecord {
  readonly directory: string
  readonly #tails = new Map<string, Promise<unknown>>()
  readonly #segments = new Map<string, Segment>()
  readonly #snapshots = new Map<string, { signature: string; snapshot: Snapshot }>()
  readonly #segmentBytes: number
  constructor(private readonly stateDirectory: string, options: { readonly segmentBytes?: number } = {}) {
    this.directory = join(stateDirectory, 'git-record')
    this.#segmentBytes = options.segmentBytes ?? 8 * 1024 * 1024
    if (!Number.isSafeInteger(this.#segmentBytes) || this.#segmentBytes < 1) throw new Error('git-record-segment-size-invalid')
  }
  #path(repository: string): string { return join(this.directory, `${canonicalRepository(repository).replace('/', '__')}.ndjson`) }
  #queue<T>(repository: string, work: () => Promise<T>): Promise<T> {
    repository = canonicalRepository(repository)
    const result = (this.#tails.get(repository) ?? Promise.resolve()).then(work)
    const tail = result.catch(() => {}); this.#tails.set(repository, tail)
    void tail.then(() => { if (this.#tails.get(repository) === tail) this.#tails.delete(repository) })
    return result
  }
  #files(repository: string): string[] {
    const base = basename(this.#path(repository), '.ndjson'), files: string[] = []
    try { statSync(this.#path(repository)); files.push(`${base}.ndjson`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { files.push(...readdirSync(join(this.directory, `${base}.segments`)).filter(file => /^\d{6}\.ndjson$/.test(file))
      .sort().map(file => join(`${base}.segments`, file))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return files
  }
  #read(repository: string): Snapshot {
    const files = this.#files(repository), segments: Segment[] = []
    for (const name of files) {
      const path = join(this.directory, name), info = statSync(path, { bigint: true })
      const signature = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`, previous = this.#segments.get(path)
      if (previous?.signature === signature) { segments.push(previous); continue }
      // Recheck a changed segment in full: a longer file may also contain an
      // edited prefix. Rotation bounds this read; unchanged segments stay cached.
      const bytes = readFileSync(path), lines: Line[] = []
      let start = 0
      while (start < bytes.length) {
        const lf = bytes.indexOf(10, start), end = lf < 0 ? bytes.length : lf + 1, exact = bytes.subarray(start, end)
        let row: GitRecordEntry | undefined
        try {
          const parsed = JSON.parse(exact.toString('utf8')) as GitRecordEntry
          if (lf >= 0 && parsed && parsed.repository === repository && typeof parsed.id === 'string' && parsed.requester &&
            ['push', 'pr.create', 'pr.update', 'pr.merge', 'pr.comment', 'pr.review', 'issue.comment', 'observed'].includes(parsed.op) &&
            ['intent', 'ok', 'refused', 'failed', 'rejected'].includes(parsed.outcome) &&
            (isGitRequester(parsed.requester) || parsed.requester.kind === 'outside' && (parsed.op === 'observed' || parsed.outcome === 'refused' || parsed.reason === 'own-git-allowed' && parsed.approval?.by === 'person'))) row = parsed
        } catch { /* A damaged physical line is counted, never thrown. */ }
        lines.push({ hash: hash(exact), row }); start = end
      }
      const segment = { name, signature, size: Number(info.size), lines }
      this.#segments.set(path, segment); segments.push(segment)
    }
    let anchor = ''
    try { anchor = readFileSync(`${this.#path(repository)}.anchor`, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const signature = JSON.stringify([segments.map(segment => segment.signature), anchor])
    const cached = this.#snapshots.get(repository)
    if (cached?.signature === signature) return cached.snapshot
    const lines = segments.flatMap(segment => segment.lines), damaged = new Set<number>()
    let prev: string | null = null
    for (const [index, line] of lines.entries()) {
      if (!line.row) damaged.add(index + 1)
      else if (line.row.prev !== prev) damaged.add(Math.max(1, index))
      prev = line.hash
    }
    try {
      const tail = JSON.parse(anchor) as { last: string | null; lines: number; segments: number }
      if (tail.last !== prev || tail.lines !== lines.length || tail.segments !== segments.length) damaged.add(Math.max(1, lines.length))
    } catch { if (lines.length || anchor) damaged.add(Math.max(1, lines.length)) }
    const rows = lines.flatMap((line, index) => line.row && !damaged.has(index + 1) ? [line.row] : [])
    const branches = new Map<string, GitRecordEntry[]>()
    for (const row of rows) if (row.branch) {
      const branch = branches.get(row.branch) ?? []; branch.push(row); branches.set(row.branch, branch)
    }
    let firstDamaged = Infinity
    for (const line of damaged) firstDamaged = Math.min(firstDamaged, line)
    const verification: GitRecordVerification = damaged.size ? { ok: false, line: firstDamaged, damaged: damaged.size } : { ok: true, damaged: 0 }
    const snapshot = { rows, last: prev, count: lines.length, segments, verification, branches }
    this.#snapshots.set(repository, { signature, snapshot }); return snapshot
  }
  async #reapStale(path: string): Promise<void> {
    try {
      const info = await stat(path), text = await readFile(path, 'utf8')
      let pid: number | undefined, at = info.mtimeMs
      try {
        const lock = JSON.parse(text)
        pid = lock.pid
        if (typeof lock.at === 'number' && Number.isFinite(lock.at)) at = lock.at
      } catch { /* A crash can leave a lock before its owner is written. */ }
      if (Date.now() - at <= 60_000) return
      if (Number.isSafeInteger(pid) && pid! > 0) {
        try { process.kill(pid!, 0); return }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return }
      }
      const current = await stat(path)
      if (current.ino === info.ino && current.mtimeMs === info.mtimeMs) await unlink(path)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  async #locked<T>(repository: string, work: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = `${this.#path(repository)}.lock`, deadline = Date.now() + 30_000
    for (;;) {
      let handle
      try { handle = await open(path, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // Reapers serialize separately so two stale-lock observers cannot
        // unlink a live replacement. A live pid is never evicted for age alone.
        let reaper
        try {
          reaper = await open(`${path}.reap`, 'wx', 0o600)
          await reaper.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
          await this.#reapStale(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') await this.#reapStale(`${path}.reap`)
          else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        finally { if (reaper) { await reaper.close(); await unlink(`${path}.reap`) } }
        if (Date.now() >= deadline) throw new Error('git-record-lock-timeout')
        await new Promise(resolve => setTimeout(resolve, 10)); continue
      }
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() })); await handle.sync()
        return await work()
      } finally { await handle.close(); await unlink(path) }
    }
  }
  async verify(repository?: string): Promise<GitRecordVerification & { readonly repository?: string }> {
    if (repository !== undefined) {
      repository = canonicalRepository(repository)
      const name = repository
      return this.#queue(name, () => this.#locked(name, async () => (this.#read(name)).verification))
    }
    for (const name of await this.#repositories()) {
      const result = await this.verify(name)
      if (!result.ok) return { ...result, repository: name }
    }
    return { ok: true, damaged: 0 }
  }
  append(entry: Omit<GitRecordEntry, 'prev'>): Promise<GitRecordEntry> {
    entry = { ...entry, repository: canonicalRepository(entry.repository) }
    const row = entry
    return this.#queue(row.repository, () => this.#locked(row.repository, () => this.#append(row)))
  }
  async #append(entry: Omit<GitRecordEntry, 'prev'>): Promise<GitRecordEntry> {
    if (entry.requester.kind === 'outside' && entry.op !== 'observed' && entry.outcome !== 'refused' && !(entry.reason === 'own-git-allowed' && entry.approval?.by === 'person')) throw new Error('git-record-outside-invalid')
    const snapshot = this.#read(entry.repository)
    if (!snapshot.verification.ok) throw new Error(`git-record-broken:${snapshot.verification.line}`)
    const row = { ...entry, prev: snapshot.last }, bytes = Buffer.from(`${JSON.stringify(row)}\n`)
    let segment = snapshot.segments.at(-1), count = snapshot.segments.length
    if (!segment || segment.size + bytes.length > this.#segmentBytes) {
      const base = basename(this.#path(entry.repository), '.ndjson')
      segment = { name: count ? join(`${base}.segments`, `${String(count).padStart(6, '0')}.ndjson`) : `${base}.ndjson`, size: 0, signature: '', lines: [] }; count++
    }
    const parent = await open(this.stateDirectory, 'r')
    try { await parent.sync() } finally { await parent.close() }
    if (count > 1) await mkdir(join(this.directory, `${basename(this.#path(entry.repository), '.ndjson')}.segments`), { recursive: true, mode: 0o700 })
    const handle = await open(join(this.directory, segment.name), 'a', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    const anchor = `${this.#path(entry.repository)}.anchor`, temporary = `${anchor}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify({ last: hash(bytes), lines: snapshot.count + 1, segments: count })); await file.sync() } finally { await file.close() }
    await rename(temporary, anchor)
    if (count > 1) {
      const segments = await open(join(this.directory, `${basename(this.#path(entry.repository), '.ndjson')}.segments`), 'r')
      try { await segments.sync() } finally { await segments.close() }
    }
    const directory = await open(this.directory, 'r')
    try { await directory.sync() } finally { await directory.close() }
    return row
  }
  list(query: GitRecordQuery): Promise<GitRecordEntry[]> {
    const repository = canonicalRepository(query.repository)
    return this.#queue(repository, () => this.#locked(repository, async () => {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1) throw new Error('git-record-limit-invalid')
      const read = this.#read(repository)
      let rows = [...(query.branch === undefined ? read.rows : read.branches.get(query.branch) ?? [])].reverse().filter(row =>
        (query.number === undefined || row.number === query.number) &&
        (query.view !== 'outside' || row.requester.kind === 'outside') && (query.view !== 'refused' || row.outcome === 'refused' || row.outcome === 'rejected'))
      if (query.before !== undefined) { const index = rows.findLastIndex(row => row.id === query.before); rows = index < 0 ? [] : rows.slice(index + 1) }
      return rows.slice(0, query.limit)
    }))
  }
  attribute(repository: string, branch: string, sha: string): Promise<GitRequester | 'outside'> {
    // Attribution is deliberately total: corrupt or unreadable host state must
    // never credit a requester or take down observation/startup.
    return this.#attribute(repository, branch, sha).catch(() => 'outside' as const)
  }
  async #attribute(repository: string, branch: string, sha: string): Promise<GitRequester | 'outside'> {
    repository = canonicalRepository(repository)
    return this.#queue(repository, () => this.#locked(repository, async () => {
      const read = this.#read(repository)
      if (!read.verification.ok) return 'outside'
      const row = read.branches.get(branch)?.findLast(row => row.op === 'push' && row.outcome === 'ok' && row.sha === sha)
      return row && row.requester.kind !== 'outside' ? row.requester : 'outside'
    }))
  }
  hasSucceededPush(query: SucceededPushQuery): boolean {
    // A synchronous index query is also usable by Lead's adoption guard. If a
    // concurrent append is between its line and anchor, it conservatively says
    // false; no partial or damaged journal can authorize adoption.
    try {
      const read = this.#read(canonicalRepository(query.repository))
      return read.verification.ok && !!read.branches.get(query.branch)?.some(row => row.op === 'push' && row.outcome === 'ok' && row.sha === query.sha &&
        row.requester.kind === query.requester.kind && 'id' in row.requester && row.requester.id === query.requester.id)
    } catch { return false }
  }
  observe(repository: string, branch: string, sha: string, previousSha: string | null): Promise<void> {
    repository = canonicalRepository(repository)
    const name = repository
    return this.#queue(name, () => this.#locked(name, async () => {
      const read = this.#read(name)
      if (!read.verification.ok) return
      // An unresolved push may have reached the remote. Reconciliation owns it;
      // do not manufacture an outside write while its outcome is unknown.
      const latest = new Map(read.branches.get(branch)?.map(row => [row.id, row]))
      if ([...latest.values()].some(row => row.sha === sha &&
        (row.op === 'push' && ['ok', 'intent'].includes(row.outcome) || row.op === 'observed'))) return
      await this.#append({ id: randomUUID(), op: 'observed', repository: name, branch, sha, previousSha, requester: { kind: 'outside' }, approval: null, at: Date.now(), outcome: 'ok' })
    }))
  }
  async #repositories(): Promise<string[]> {
    try { return [...new Set((await readdir(this.directory)).filter(file => file.endsWith('.ndjson') || file.endsWith('.ndjson.anchor'))
      .map(file => canonicalRepository(file.replace(/\.ndjson(?:\.anchor)?$/, '').replace('__', '/'))))].sort() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  async pending(): Promise<GitRecordEntry[]> {
    const pending: GitRecordEntry[] = []
    for (const repository of await this.#repositories()) await this.#queue(repository, () => this.#locked(repository, async () => {
      const read = this.#read(repository)
      if (!read.verification.ok) return
      const latest = new Map(read.rows.map(row => [row.id, row]))
      pending.push(...[...latest.values()].filter(row => row.outcome === 'intent'))
    }))
    return pending
  }
  stats(repository: string): Promise<{ entries: number; damaged: number; segments: number }> {
    repository = canonicalRepository(repository)
    const name = repository
    return this.#queue(name, () => this.#locked(name, async () => {
      const read = this.#read(name)
      return { entries: read.rows.length, damaged: read.verification.damaged, segments: read.segments.length }
    }))
  }
}
