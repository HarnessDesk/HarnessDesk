import type { DatabaseSync, StatementSync } from 'node:sqlite'

import { sessionIndexCursorOf, type HistoryImportState, type HistorySummary, type HostParams, type Page, type RepoInfo, type RuntimeId, type SessionId, type SessionSummary } from '@harnessdesk/protocol'

import { dropSessionBody, openSessionDatabase } from './session-database.js'

import { seedSummaries } from './session-index-seed.js'

export interface SessionIndexChange {
  readonly resolveRepos?: boolean
  readonly upserted: readonly SessionSummary[]
  readonly removed: readonly { runtime: RuntimeId; id: SessionId }[]
}

export interface SessionIndexSeedOptions {
  readonly teamOf?: (runtime: RuntimeId, id: SessionId) => string | null
  readonly archiveCapability?: (runtime: RuntimeId) => boolean | undefined
  readonly titleOf?: (runtime: RuntimeId, id: SessionId) => string | null
}

interface Row {
  runtime: RuntimeId
  id: SessionId
  origin: 'desk' | 'imported'
  title: string | null
  preview: string | null
  cwd: string
  created_at: number
  updated_at: number
  archived: number | null
  removed_at: number | null
  team_id: string | null
  status: string
  git: string | null
  cached_root: string | null
  worktree: number | null
  origin_url: string | null
  exists: number | null
}

interface RepoRow { repo_root: string | null; worktree: number; origin_url: string | null; exists: number; checked_at: number; identity: string | null }
type RepoValue = { repo: RepoInfo | null; exists: boolean; checkedAt: number; identity?: string }
interface PendingFacts { title?: string | null; archived?: boolean | null; teamId?: string | null }
const pendingKey = (runtime: RuntimeId, id: SessionId): string => `pending:${JSON.stringify([runtime, id])}`
const SELECT = `SELECT s.*, r.repo_root AS cached_root, r.worktree, r.origin_url, r."exists"
  FROM sessions s LEFT JOIN repos r ON r.cwd = s.cwd`
const eligible = (row: Row): boolean => row.origin === 'desk' && row.removed_at === null && row.team_id === null
const summaryOf = (row: Row): SessionSummary => ({
  runtime: row.runtime, id: row.id, title: row.title, preview: row.preview, cwd: row.cwd,
  createdAt: row.created_at, updatedAt: row.updated_at, status: JSON.parse(row.status) as SessionSummary['status'],
  ...(row.git ? { git: JSON.parse(row.git) as SessionSummary['git'] } : {}),
  repo: row.cached_root ? { root: row.cached_root, worktree: Boolean(row.worktree), ...(row.origin_url ? { origin: row.origin_url } : {}) } : null,
  archived: Boolean(row.archived), ...(row.exists === null ? {} : { folderGone: !row.exists }),
})

/** A list-only local index. Queries never read a transcript or ask an agent or Git. */
export class SessionIndex {
  readonly #db: DatabaseSync
  readonly #get: StatementSync
  readonly #write: StatementSync
  readonly #onChange: ((change: SessionIndexChange) => void) | undefined
  readonly #pending = new Map<string, { runtime: RuntimeId; id: SessionId; summary: SessionSummary | null; resolveRepos: boolean }>()
  #scheduled = false
  #closed = false
  #seeding: Promise<void> | null = null

  constructor(file: string, onChange?: (change: SessionIndexChange) => void) {
    this.#onChange = onChange
    this.#db = openSessionDatabase(file)
    this.#get = this.#db.prepare(`${SELECT} WHERE s.runtime = ? AND s.id = ?`)
    this.#write = this.#db.prepare(`INSERT INTO sessions
      (runtime,id,origin,title,preview,cwd,repo_root,created_at,updated_at,archived,team_id,status,git)
      VALUES (?,?,?,?,?,?,(SELECT repo_root FROM repos WHERE cwd = ?),?,?,?,?,?,?)
      ON CONFLICT(runtime,id) DO UPDATE SET title=excluded.title,preview=excluded.preview,
        cwd=excluded.cwd,repo_root=excluded.repo_root,created_at=excluded.created_at,updated_at=excluded.updated_at,
        archived=COALESCE(?,sessions.archived),team_id=CASE WHEN ? THEN excluded.team_id ELSE sessions.team_id END,
        status=excluded.status,git=excluded.git`)
  }

  #transaction<T>(write: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try { const result = write(); this.#db.exec('COMMIT'); return result }
    catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }

  #row(runtime: RuntimeId, id: SessionId): Row | undefined { return this.#get.get(runtime, id) as Row | undefined }

  #facts(runtime: RuntimeId, id: SessionId): PendingFacts {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key=?').get(pendingKey(runtime, id))
    return row ? JSON.parse(String(row.value)) as PendingFacts : {}
  }

  #saveFacts(runtime: RuntimeId, id: SessionId, patch: PendingFacts): void {
    this.#db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(pendingKey(runtime, id), JSON.stringify({ ...this.#facts(runtime, id), ...patch }))
  }

  #clearFacts(runtime: RuntimeId, id: SessionId): void {
    this.#db.prepare('DELETE FROM meta WHERE key=?').run(pendingKey(runtime, id))
  }

  #notify(runtime: RuntimeId, id: SessionId, resolveRepos = true): void {
    if (!this.#onChange || this.#closed) return
    const row = this.#row(runtime, id)
    this.#pending.set(JSON.stringify([runtime, id]), { runtime, id, resolveRepos, summary: row && eligible(row) && row.archived !== null ? summaryOf(row) : null })
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      if (this.#closed) return
      const changes = [...this.#pending.values()]
      this.#pending.clear()
      this.#onChange?.({ resolveRepos: changes.some(change => change.resolveRepos), upserted: changes.flatMap((change) => change.summary ? [change.summary] : []),
        removed: changes.filter((change) => !change.summary).map(({ runtime, id }) => ({ runtime, id })) })
    })
  }

  upsert(summary: SessionSummary, options: { origin?: 'desk' | 'imported'; archived?: boolean | null; teamId?: string | null } = {}): void {
    this.#transaction(() => {
      const facts = this.#facts(summary.runtime, summary.id)
      const archived = options.archived === undefined ? facts.archived : options.archived
      const teamId = options.teamId === undefined ? facts.teamId : options.teamId
      this.#write.run(summary.runtime, summary.id, options.origin ?? 'desk', facts.title === undefined ? summary.title ?? null : facts.title,
        summary.preview ?? null, summary.cwd, summary.cwd, summary.createdAt, summary.updatedAt,
        archived === null ? null : Number(archived ?? summary.archived ?? false), teamId ?? null, JSON.stringify(summary.status),
        summary.git ? JSON.stringify(summary.git) : null,
        archived == null ? null : Number(archived), Number(teamId !== undefined))
      this.#clearFacts(summary.runtime, summary.id)
    })
    this.#notify(summary.runtime, summary.id)
  }

  /** Create/fork and the first new turn are the only adoption seams. */
  promote(runtime: RuntimeId, id: SessionId): void {
    const result = this.#db.prepare("UPDATE sessions SET origin='desk',body=CASE WHEN body='cached' THEN 'full' ELSE body END WHERE runtime=? AND id=? AND origin='imported' AND removed_at IS NULL").run(runtime, id)
    if (result.changes) this.#notify(runtime, id)
  }

  isImported(runtime: RuntimeId, id: SessionId): boolean {
    return this.#row(runtime, id)?.origin === 'imported'
  }

  opened(runtime: RuntimeId, id: SessionId): void {
    this.#db.prepare('UPDATE sessions SET last_opened_at=? WHERE runtime=? AND id=?').run(Date.now(), runtime, id)
  }

  list(options: { cursor?: string; pageSize?: number; archived?: 'exclude' | 'only'; runtimes?: readonly RuntimeId[] } = {}): Page<SessionSummary> {
    const pageSize = Math.min(500, Math.max(1, Math.floor(options.pageSize ?? 50)))
    const archived = options.archived === 'only' ? 1 : 0
    const params: (string | number)[] = [archived]
    let after = ''
    if (options.cursor) {
      let cursor: unknown
      try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) }
      catch { throw new Error('Invalid session index cursor') }
      if (!Array.isArray(cursor) || cursor.length !== 4 || !Number.isFinite(cursor[0]) || typeof cursor[1] !== 'string' ||
        typeof cursor[2] !== 'string' || cursor[3] !== archived) throw new Error('Invalid session index cursor')
      after = ' AND (s.updated_at < ? OR (s.updated_at = ? AND (s.runtime > ? OR (s.runtime = ? AND s.id > ?))))'
      params.push(cursor[0] as number, cursor[0] as number, cursor[1], cursor[1], cursor[2])
    }
    if (options.runtimes !== undefined) {
      if (options.runtimes.length === 0) return { data: [], nextCursor: null }
      after += ` AND s.runtime IN (${options.runtimes.map(() => '?').join(',')})`
      params.push(...options.runtimes)
    }
    const rows = this.#db.prepare(`${SELECT} WHERE s.origin='desk' AND s.removed_at IS NULL AND s.team_id IS NULL
      AND s.archived = ?${after} ORDER BY s.updated_at DESC,s.runtime,s.id LIMIT ?`).all(...params, pageSize + 1) as unknown as Row[]
    const data = rows.slice(0, pageSize)
    const last = data.at(-1)
    return { data: data.map(summaryOf), nextCursor: rows.length > pageSize && last
      ? sessionIndexCursorOf({ updatedAt: last.updated_at, runtime: last.runtime, id: last.id }, options.archived) : null }
  }

  /** One page, one transaction. Desk metadata/body and removal tombstones win. */
  importPage(rows: readonly SessionSummary[], archivedOf: (row: SessionSummary) => boolean | null): void {
    const changed: { runtime: RuntimeId; id: SessionId }[] = []
    this.#transaction(() => {
      const write = this.#db.prepare(`INSERT INTO sessions(runtime,id,origin,title,cwd,repo_root,created_at,updated_at,archived)
        VALUES(?,?,'imported',?,?,(SELECT repo_root FROM repos WHERE cwd=?),?,?,?)
        ON CONFLICT(runtime,id) DO UPDATE SET
          title=CASE WHEN sessions.origin='imported' THEN excluded.title ELSE sessions.title END,
          cwd=CASE WHEN sessions.origin='imported' THEN excluded.cwd ELSE sessions.cwd END,
          repo_root=CASE WHEN sessions.origin='imported' THEN excluded.repo_root ELSE sessions.repo_root END,
          created_at=CASE WHEN sessions.origin='imported' THEN excluded.created_at ELSE sessions.created_at END,
          updated_at=CASE WHEN sessions.origin='imported' THEN excluded.updated_at ELSE sessions.updated_at END,
          archived=COALESCE(excluded.archived,sessions.archived) WHERE sessions.removed_at IS NULL`)
      for (const row of rows) {
        const previous = this.#row(row.runtime, row.id)
        if (previous?.removed_at != null) continue
        const { archived: pendingArchive, ...pending } = this.#facts(row.runtime, row.id)
        // A null observation is stale. Keep an action on an existing row or
        // the pending mark for a conversation this page has not inserted yet.
        const observed = archivedOf(row) ?? previous?.archived ?? pendingArchive ?? null
        const archived = observed === null ? null : Number(observed)
        write.run(row.runtime, row.id, row.title ?? null, row.cwd, row.cwd, row.createdAt, row.updatedAt, archived)
        // The row now owns archive state; leave other deferred facts for upsert.
        if (pendingArchive !== undefined) {
          this.#clearFacts(row.runtime, row.id)
          if (Object.keys(pending).length) this.#saveFacts(row.runtime, row.id, pending)
        }
        if (previous?.origin === 'desk' && previous.archived !== archived) changed.push(row)
      }
    })
    for (const row of changed) this.#notify(row.runtime, row.id, false)
  }

  importedCount(runtime: RuntimeId): number {
    return Number(this.#db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE runtime=? AND origin='imported' AND removed_at IS NULL").get(runtime)?.n)
  }

  importStatus(runtime: RuntimeId): HistoryImportState | null {
    const row = this.#db.prepare('SELECT * FROM imports WHERE runtime=?').get(runtime)
    return row ? { state: row.state as HistoryImportState['state'], count: Number(row.count),
      importedAt: row.imported_at == null ? null : Number(row.imported_at), lastScanAt: Number(row.last_scan_at),
      ...(row.error == null ? {} : { error: String(row.error) }) } : null
  }

  saveImport(runtime: RuntimeId, value: HistoryImportState): void {
    this.#db.prepare(`INSERT INTO imports(runtime,imported_at,count,last_scan_at,state,error) VALUES(?,?,?,?,?,?)
      ON CONFLICT(runtime) DO UPDATE SET imported_at=excluded.imported_at,count=excluded.count,
        last_scan_at=excluded.last_scan_at,state=excluded.state,error=excluded.error`)
      .run(runtime, value.importedAt, value.count, value.lastScanAt, value.state, value.error ?? null)
  }

  interruptImports(): void {
    this.#db.prepare("UPDATE imports SET state='cancelled' WHERE state='running'").run()
  }

  removeImported(runtime: RuntimeId): readonly { runtime: RuntimeId; id: SessionId }[] {
    return this.#transaction(() => {
      const rows = this.#db.prepare("SELECT runtime,id FROM sessions WHERE runtime=? AND origin='imported' AND removed_at IS NULL").all(runtime) as unknown as { runtime: RuntimeId; id: SessionId }[]
      for (const row of rows) {
        dropSessionBody(this.#db, row.runtime, row.id)
        this.#db.prepare('DELETE FROM sessions WHERE runtime=? AND id=?').run(row.runtime, row.id)
        this.#clearFacts(row.runtime, row.id)
      }
      this.#db.prepare('DELETE FROM imports WHERE runtime=?').run(runtime)
      return rows
    })
  }

  history(options: HostParams<'history/list'> = {}): Page<HistorySummary> {
    const params: (string | number)[] = []
    let where = "s.origin='imported'"
    if (!options.includeHidden) where += ' AND s.removed_at IS NULL'
    if (options.runtimes !== undefined) {
      if (!options.runtimes.length) return { data: [], nextCursor: null }
      where += ` AND s.runtime IN (${options.runtimes.map(() => '?').join(',')})`
      params.push(...options.runtimes)
    }
    if (options.repoRoot !== undefined) { where += ' AND s.repo_root=?'; params.push(options.repoRoot) }
    if (options.query) {
      where += " AND s.title LIKE ? ESCAPE '\\'"
      params.push(`%${options.query.replace(/[\\%_]/g, '\\$&')}%`)
    }
    if (options.cursor) {
      let cursor: unknown
      try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) }
      catch { throw new Error('Invalid history cursor') }
      if (!Array.isArray(cursor) || cursor.length !== 4 || !Number.isFinite(cursor[0]) || typeof cursor[1] !== 'string' ||
        typeof cursor[2] !== 'string' || cursor[3] !== Boolean(options.includeHidden)) throw new Error('Invalid history cursor')
      where += ' AND (s.updated_at < ? OR (s.updated_at = ? AND (s.runtime > ? OR (s.runtime = ? AND s.id > ?))))'
      params.push(cursor[0] as number, cursor[0] as number, cursor[1], cursor[1], cursor[2])
    }
    const size = Math.min(500, Math.max(1, Math.floor(options.pageSize ?? 50)))
    const rows = this.#db.prepare(`${SELECT} WHERE ${where} ORDER BY s.updated_at DESC,s.runtime,s.id LIMIT ?`).all(...params, size + 1) as unknown as Row[]
    const data = rows.slice(0, size), last = data.at(-1)
    return { data: data.map(row => ({ ...summaryOf(row), hidden: row.removed_at !== null })), nextCursor: rows.length > size && last
      ? Buffer.from(JSON.stringify([last.updated_at, last.runtime, last.id, Boolean(options.includeHidden)])).toString('base64url') : null }
  }

  remove(runtime: RuntimeId, id: SessionId): void {
    // A tombstone also covers a file the background seed has not reached yet.
    this.#transaction(() => {
      this.#db.prepare(`INSERT INTO sessions(runtime,id,origin,cwd,created_at,updated_at,removed_at)
        VALUES (?,?,'desk','',0,0,?) ON CONFLICT(runtime,id) DO UPDATE SET removed_at=excluded.removed_at`).run(runtime, id, Date.now())
      this.#clearFacts(runtime, id)
    })
    this.#notify(runtime, id)
  }

  setTitle(runtime: RuntimeId, id: SessionId, title: string | null): void {
    this.#transaction(() => {
      if (!this.#row(runtime, id)) this.#saveFacts(runtime, id, { title })
      else this.#db.prepare('UPDATE sessions SET title=? WHERE runtime=? AND id=? AND removed_at IS NULL').run(title, runtime, id)
    })
    this.#notify(runtime, id)
  }

  setArchived(runtime: RuntimeId, id: SessionId, archived: boolean, resolveRepos = true): void {
    this.#transaction(() => {
      if (!this.#row(runtime, id)) this.#saveFacts(runtime, id, { archived })
      else this.#db.prepare('UPDATE sessions SET archived=? WHERE runtime=? AND id=? AND removed_at IS NULL').run(Number(archived), runtime, id)
    })
    this.#notify(runtime, id, resolveRepos)
  }

  /** Only an already indexed, retained conversation can receive authority facts. */
  confirmArchived(runtime: RuntimeId, id: SessionId, archived: boolean): void {
    const row = this.#row(runtime, id)
    if (!row || row.removed_at !== null) return
    this.setArchived(runtime, id, archived, false)
  }

  unresolvedArchive(runtime: RuntimeId): readonly SessionId[] {
    return (this.#db.prepare('SELECT id FROM sessions WHERE runtime=? AND archived IS NULL AND removed_at IS NULL').all(runtime) as { id: SessionId }[]).map(row => row.id)
  }

  archiveError(runtime: RuntimeId, error: string): void {
    this.#db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`archive-error:${runtime}`, error)
  }

  clearArchiveError(runtime: RuntimeId): void {
    this.#db.prepare('DELETE FROM meta WHERE key=?').run(`archive-error:${runtime}`)
  }

  setTeam(runtime: RuntimeId, id: SessionId, teamId: string | null): void {
    this.#transaction(() => {
      if (!this.#row(runtime, id)) this.#saveFacts(runtime, id, { teamId })
      else this.#db.prepare('UPDATE sessions SET team_id=? WHERE runtime=? AND id=? AND removed_at IS NULL').run(teamId, runtime, id)
    })
    this.#notify(runtime, id)
  }

  repo(cwd: string): RepoValue | null {
    const row = this.#db.prepare('SELECT * FROM repos WHERE cwd=?').get(cwd) as unknown as RepoRow | undefined
    return row ? { repo: row.repo_root ? { root: row.repo_root, worktree: Boolean(row.worktree),
      ...(row.origin_url ? { origin: row.origin_url } : {}) } : null, exists: Boolean(row.exists), checkedAt: row.checked_at, ...(row.identity ? { identity: row.identity } : {}) } : null
  }

  putRepo(cwd: string, value: RepoValue): void {
    const previous = this.repo(cwd)
    this.#transaction(() => {
      this.#db.prepare(`INSERT INTO repos(cwd,repo_root,origin_url,worktree,"exists",checked_at,identity) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(cwd) DO UPDATE SET repo_root=excluded.repo_root,origin_url=excluded.origin_url,worktree=excluded.worktree,
          "exists"=excluded."exists",checked_at=excluded.checked_at,identity=excluded.identity`).run(cwd, value.repo?.root ?? null, value.repo?.origin ?? null,
        Number(value.repo?.worktree ?? false), Number(value.exists), value.checkedAt, value.identity ?? null)
      this.#db.prepare('UPDATE sessions SET repo_root=? WHERE cwd=?').run(value.repo?.root ?? null, cwd)
    })
    if (previous && previous.exists === value.exists && JSON.stringify(previous.repo) === JSON.stringify(value.repo)) return
    for (const row of this.#db.prepare(`${SELECT} WHERE s.cwd=? AND s.origin='desk' AND s.removed_at IS NULL AND s.team_id IS NULL`).all(cwd) as unknown as Row[]) {
      this.#notify(row.runtime, row.id)
    }
  }

  forFolder(cwd: string): readonly SessionSummary[] {
    return (this.#db.prepare(`${SELECT} WHERE s.cwd=? AND s.origin='desk' AND s.removed_at IS NULL AND s.team_id IS NULL`).all(cwd) as unknown as Row[]).map(summaryOf)
  }

  seed(stateDir: string, options: SessionIndexSeedOptions = {}): Promise<void> {
    if (this.#closed || this.#db.prepare("SELECT 1 FROM meta WHERE key='seed:transcripts:v1'").get()) return Promise.resolve()
    if (this.#seeding) return this.#seeding
    this.#seeding = this.#seed(stateDir, options).finally(() => { this.#seeding = null })
    return this.#seeding
  }

  async #seed(stateDir: string, options: SessionIndexSeedOptions): Promise<void> {
    for await (const batch of seedSummaries(stateDir)) {
      if (this.#closed) return
      const inserted: SessionSummary[] = []
      this.#transaction(() => {
        for (const summary of batch) {
          // Live writes, prior batches and deletion tombstones always win.
          if (this.#row(summary.runtime, summary.id)) continue
          const facts = this.#facts(summary.runtime, summary.id)
          const title = facts.title === undefined ? options.titleOf?.(summary.runtime, summary.id) ?? summary.title ?? null : facts.title
          const teamId = facts.teamId === undefined ? options.teamOf?.(summary.runtime, summary.id) ?? null : facts.teamId
          this.#write.run(summary.runtime, summary.id, 'desk', title, summary.preview ?? null, summary.cwd, summary.cwd,
            summary.createdAt, summary.updatedAt, facts.archived === undefined && options.archiveCapability && options.archiveCapability(summary.runtime) !== false
              ? null : Number(facts.archived ?? summary.archived ?? false), teamId,
            JSON.stringify(summary.status), null, null, 0)
          this.#clearFacts(summary.runtime, summary.id)
          inserted.push(summary)
        }
      })
      for (const summary of inserted) this.#notify(summary.runtime, summary.id)
    }
    if (!this.#closed) this.#transaction(() => this.#db.prepare("INSERT INTO meta(key,value) VALUES('seed:transcripts:v1','1') ON CONFLICT DO NOTHING").run())
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#pending.clear()
    this.#db.close()
  }
}
