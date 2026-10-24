import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface GitRequester {
  readonly kind: 'lead-goal' | 'session' | 'person'
  readonly id: string
  readonly seat?: { readonly label: string; readonly role: string | null; readonly round: number | null; readonly team: string | null } | null
  readonly conversation?: { readonly runtime: string; readonly sessionId: string; readonly title?: string } | null
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
export type GitRecordVerification = { readonly ok: true } | { readonly ok: false; readonly line: number }
export const validateRepository = (repository: string): void => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..'))
    throw new Error('git-gateway-repository-invalid')
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** Host-state journal. Each link hashes the previous line's exact bytes,
 * including its LF. A damaged chain fails closed for reads and appends. */
export class GitRecord {
  readonly directory: string
  readonly #tails = new Map<string, Promise<unknown>>()
  constructor(private readonly stateDirectory: string) { this.directory = join(stateDirectory, 'git-record') }
  #path(repository: string): string { validateRepository(repository); return join(this.directory, `${repository.replace('/', '__')}.ndjson`) }
  #queue<T>(repository: string, work: () => Promise<T>): Promise<T> {
    const result = (this.#tails.get(repository) ?? Promise.resolve()).then(work)
    const tail = result.catch(() => {}); this.#tails.set(repository, tail)
    void tail.then(() => { if (this.#tails.get(repository) === tail) this.#tails.delete(repository) })
    return result
  }
  async #read(repository: string): Promise<{ rows: GitRecordEntry[]; last: string | null; verification: GitRecordVerification }> {
    let bytes: Buffer
    try { bytes = await readFile(this.#path(repository)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], last: null, verification: { ok: true } }; throw error }
    const rows: GitRecordEntry[] = []
    let start = 0, prev: string | null = null
    while (start < bytes.length) {
      const end = bytes.indexOf(10, start), line = rows.length + 1
      if (end < 0) return { rows, last: prev, verification: { ok: false, line } }
      const exact = bytes.subarray(start, end + 1)
      let row: GitRecordEntry
      try { row = JSON.parse(exact.toString('utf8')) as GitRecordEntry }
      catch { return { rows, last: prev, verification: { ok: false, line } } }
      if (!row || row.prev !== prev || row.repository !== repository || typeof row.id !== 'string' || !row.requester ||
        (row.requester.kind === 'outside' && row.op !== 'observed')) return { rows, last: prev, verification: { ok: false, line } }
      rows.push(row); prev = hash(exact); start = end + 1
    }
    return { rows, last: prev, verification: { ok: true } }
  }
  async #checked(repository: string) {
    const read = await this.#read(repository)
    if (!read.verification.ok) throw new Error(`git-record-broken:${read.verification.line}`)
    return read
  }
  async verify(repository?: string): Promise<GitRecordVerification & { readonly repository?: string }> {
    if (repository !== undefined) return this.#queue(repository, async () => (await this.#read(repository)).verification)
    let repositories: string[]
    try { repositories = await this.#repositories() }
    catch (error) { if (error instanceof SyntaxError || /git-record-broken:1/.test(String(error))) return { ok: false, line: 1 }; throw error }
    for (const name of repositories) {
      const result = await this.verify(name)
      if (!result.ok) return { ...result, repository: name }
    }
    return { ok: true }
  }
  append(entry: Omit<GitRecordEntry, 'prev'>): Promise<GitRecordEntry> {
    return this.#queue(entry.repository, () => this.#append(entry))
  }
  async #append(entry: Omit<GitRecordEntry, 'prev'>): Promise<GitRecordEntry> {
    if (entry.requester.kind === 'outside' && entry.op !== 'observed') throw new Error('git-record-outside-invalid')
    const { last } = await this.#checked(entry.repository), row = { ...entry, prev: last }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // Persist a newly created journal directory before an intent authorizes an effect.
    const parent = await open(this.stateDirectory, 'r')
    try { await parent.sync() } finally { await parent.close() }
    const handle = await open(this.#path(entry.repository), 'a', 0o600)
    try { await handle.writeFile(`${JSON.stringify(row)}\n`); await handle.sync() } finally { await handle.close() }
    const directory = await open(this.directory, 'r')
    try { await directory.sync() } finally { await directory.close() }
    return row
  }
  list(query: GitRecordQuery): Promise<GitRecordEntry[]> {
    return this.#queue(query.repository, async () => {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1) throw new Error('git-record-limit-invalid')
      let rows = (await this.#checked(query.repository)).rows.reverse().filter(row =>
        (query.branch === undefined || row.branch === query.branch) && (query.number === undefined || row.number === query.number) &&
        (query.view !== 'outside' || row.op === 'observed') && (query.view !== 'refused' || row.outcome === 'refused' || row.outcome === 'rejected'))
      if (query.before !== undefined) { const index = rows.findLastIndex(row => row.id === query.before); rows = index < 0 ? [] : rows.slice(index + 1) }
      return rows.slice(0, query.limit)
    })
  }
  attribute(repository: string, branch: string, sha: string): Promise<GitRequester | 'outside'> {
    return this.#queue(repository, async () => {
      const row = (await this.#checked(repository)).rows.reverse().find(row => row.op === 'push' && row.outcome === 'ok' && row.branch === branch && row.sha === sha)
      return row && row.requester.kind !== 'outside' ? row.requester : 'outside'
    })
  }
  observe(repository: string, branch: string, sha: string, previousSha: string | null): Promise<void> {
    return this.#queue(repository, async () => {
      const { rows } = await this.#checked(repository)
      if (rows.some(row => row.branch === branch && row.sha === sha &&
        (row.op === 'push' && row.outcome === 'ok' || row.op === 'observed'))) return
      await this.#append({ id: randomUUID(), op: 'observed', repository, branch, sha, previousSha, requester: { kind: 'outside' }, approval: null, at: Date.now(), outcome: 'ok' })
    })
  }
  async #repositories(): Promise<string[]> {
    let files: string[]
    try { files = await readdir(this.directory) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const repositories: string[] = []
    for (const file of files.filter(file => file.endsWith('.ndjson')).sort()) {
      const contents = await readFile(join(this.directory, file), 'utf8'), first = contents.split('\n')[0]
      if (!contents) continue
      if (!first) throw new Error('git-record-broken:1')
      const repository = (JSON.parse(first) as GitRecordEntry).repository
      try { validateRepository(repository) } catch { throw new Error('git-record-broken:1') }
      if (basename(this.#path(repository)) !== file) throw new Error('git-record-broken:1')
      repositories.push(repository)
    }
    return repositories
  }
  async pending(): Promise<GitRecordEntry[]> {
    const pending: GitRecordEntry[] = []
    for (const repository of await this.#repositories()) {
      const { rows } = await this.#queue(repository, () => this.#checked(repository))
      const latest = new Map(rows.map(row => [row.id, row]))
      pending.push(...[...latest.values()].filter(row => row.outcome === 'intent'))
    }
    return pending
  }
}
