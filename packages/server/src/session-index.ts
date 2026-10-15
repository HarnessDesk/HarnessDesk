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
  readonly signal?: AbortSignal
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
  worktree_path: string | null
  worktree_branch: string | null
  worktree_state: SessionWorktreeRecord['state'] | null
  status: string
  git: string | null
  cached_root: string | null
  worktree: number | null
  origin_url: string | null
  exists: number | null
}

export interface SessionWorktreeRecord {
  runtime: RuntimeId; id: SessionId; path: string; branch: string | null; root: string
  state: 'present' | 'removed' | 'kept'
}

interface RepoRow { repo_root: string | null; worktree: number; origin_url: string | null; exists: number; checked_at: number; identity: string | null }
type RepoValue = { repo: RepoInfo | null; exists: boolean; checkedAt: number; identity?: string }
interface PendingFacts { title?: string | null; archived?: boolean | null; teamId?: string | null }
const pendingKey = (runtime: RuntimeId, id: SessionId): string => `pending:${JSON.stringify([runtime, id])}`
const removalOriginKey = (runtime: RuntimeId, id: SessionId): string => `removed-origin:${JSON.stringify([runtime, id])}`
export const SESSION_REMOVE_UNDO_MS = 8_000
const SELECT = `SELECT s.*, r.repo_root AS cached_root, r.worktree, r.origin_url, r."exists"
  FROM sessions s LEFT JOIN repos r ON r.cwd = s.cwd`
const eligible = (row: Row): boolean => row.origin === 'desk' && row.removed_at === null && row.team_id === null
const summaryOf = (row: Row): SessionSummary => ({
  runtime: row.runtime, id: row.id, title: row.title, preview: row.preview, cwd: row.cwd,
  createdAt: row.created_at, updatedAt: row.updated_at, status: JSON.parse(row.status) as SessionSummary['status'],
  ...(row.git ? { git: JSON.parse(row.git) as SessionSummary['git'] } : {}),
  repo: row.cached_root ? { root: row.cached_root, worktree: Boolean(row.worktree), ...(row.origin_url ? { origin: row.origin_url } : {}) } : null,
  ...(row.worktree_path && row.worktree_state ? { worktree: { path: row.worktree_path, branch: row.worktree_branch, state: row.worktree_state } } : {}),
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
      ON CONFLICT(runtime,id) DO UPDATE SET title=COALESCE(sessions.title,excluded.title),preview=excluded.preview,
        cwd=excluded.cwd,repo_root=excluded.repo_root,created_at=excluded.created_at,updated_at=MAX(sessions.updated_at,excluded.updated_at),
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
    if (this.isRemoved(summary.runtime, summary.id)) return
    this.#transaction(() => {
      // A deferred metadata observation can predate activity already recorded
      // by another writer. It must not make a conversation older for cleanup.
      const facts = this.#facts(summary.runtime, summary.id)
      const archived = options.archived === undefined ? facts.archived : options.archived
      const teamId = options.teamId === undefined ? facts.teamId : options.teamId
      if (facts.title !== undefined) this.#db.prepare('UPDATE sessions SET title=? WHERE runtime=? AND id=? AND removed_at IS NULL')
        .run(facts.title, summary.runtime, summary.id)
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
    const params: (string | number)[] = [archived, archived]
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
    const rows = this.#db.prepare(`${SELECT} WHERE s.origin='desk' AND s.removed_at IS NULL AND (? = 1 OR s.team_id IS NULL)
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
          title=COALESCE(sessions.title,excluded.title),
          cwd=CASE WHEN sessions.origin='imported' THEN excluded.cwd ELSE sessions.cwd END,
          repo_root=CASE WHEN sessions.origin='imported' THEN excluded.repo_root ELSE sessions.repo_root END,
          created_at=CASE WHEN sessions.origin='imported' THEN excluded.created_at ELSE sessions.created_at END,
          updated_at=CASE WHEN sessions.origin='imported' THEN excluded.updated_at ELSE sessions.updated_at END,
          archived=COALESCE(excluded.archived,sessions.archived) WHERE sessions.removed_at IS NULL`)
      for (const row of rows) {
        const previous = this.#row(row.runtime, row.id)
        if (this.isRemoved(row.runtime, row.id)) continue
        const { archived: pendingArchive, title: pendingTitle, ...pending } = this.#facts(row.runtime, row.id)
        // A null observation is stale. Keep an action on an existing row or
        // the pending mark for a conversation this page has not inserted yet.
        const observed = archivedOf(row) ?? previous?.archived ?? pendingArchive ?? null
        const archived = observed === null ? null : Number(observed)
        write.run(row.runtime, row.id, pendingTitle === undefined ? row.title ?? null : pendingTitle,
          row.cwd, row.cwd, row.createdAt, row.updatedAt, archived)
        if (pendingTitle !== undefined) this.#db.prepare('UPDATE sessions SET title=? WHERE runtime=? AND id=?')
          .run(pendingTitle, row.runtime, row.id)
        // The row now owns the name and archive state; leave Team facts for upsert.
        if (pendingArchive !== undefined || pendingTitle !== undefined) {
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

  /** Only an explicit create/fork may admit a newly minted reuse of a deleted id. */
  admitCreated(runtime: RuntimeId, id: SessionId): void {
    this.#db.prepare('DELETE FROM meta WHERE key=?').run(`deleted:${JSON.stringify([runtime, id])}`)
  }

  isRemoved(runtime: RuntimeId, id: SessionId): boolean {
    return this.#row(runtime, id)?.removed_at != null || !!this.#db.prepare('SELECT 1 FROM meta WHERE key=?').get(`deleted:${JSON.stringify([runtime, id])}`)
  }

  /** A successful explicit open admits a removed row even after Undo expires. */
  admitReopened(runtime: RuntimeId, id: SessionId): boolean {
    if (this.#row(runtime, id)?.removed_at == null) return false
    this.#transaction(() => {
      this.#db.prepare("UPDATE sessions SET origin='desk',removed_at=NULL WHERE runtime=? AND id=? AND removed_at IS NOT NULL").run(runtime, id)
      this.#db.prepare('DELETE FROM meta WHERE key=?').run(removalOriginKey(runtime, id))
    })
    return true
  }

  remove(runtime: RuntimeId, id: SessionId): number {
    const row = this.#row(runtime, id)
    if (row?.removed_at != null) return row.removed_at + SESSION_REMOVE_UNDO_MS
    const at = Date.now()
    this.#transaction(() => {
      this.#db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT DO NOTHING')
        .run(removalOriginKey(runtime, id), row?.origin ?? 'desk')
      // A tombstone also covers a file the background seed has not reached yet.
      this.#db.prepare(`INSERT INTO sessions(runtime,id,origin,cwd,created_at,updated_at,removed_at)
        VALUES (?,?,'imported','',0,0,?) ON CONFLICT(runtime,id) DO UPDATE SET origin='imported',removed_at=excluded.removed_at`).run(runtime, id, at)
      this.#clearFacts(runtime, id)
    })
    this.#notify(runtime, id)
    return at + SESSION_REMOVE_UNDO_MS
  }

  undoRemove(runtime: RuntimeId, id: SessionId): void {
    const row = this.#row(runtime, id)
    if (!row || row.removed_at === null) return
    if (Date.now() >= row.removed_at + SESSION_REMOVE_UNDO_MS) throw new Error('The Undo window has ended.')
    this.#transaction(() => {
      const origin = this.#db.prepare('SELECT value FROM meta WHERE key=?').get(removalOriginKey(runtime, id))?.value ?? 'desk'
      this.#db.prepare('UPDATE sessions SET origin=?,removed_at=NULL WHERE runtime=? AND id=?').run(String(origin), runtime, id)
      this.#db.prepare('DELETE FROM meta WHERE key=?').run(removalOriginKey(runtime, id))
    })
    this.#notify(runtime, id)
  }

  /** The body writer deleted the row and body in one transaction. */
  deleted(runtime: RuntimeId, id: SessionId): void { this.#notify(runtime, id) }

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
    if (!row || row.removed_at !== null || row.archived === Number(archived)) return
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

  get(runtime: RuntimeId, id: SessionId): SessionSummary | null {
    const row = this.#row(runtime, id)
    return row ? summaryOf(row) : null
  }

  storageWorktrees(): readonly (SessionWorktreeRecord & { title: string | null; updatedAt: number | null; hidden: boolean })[] {
    return this.#db.prepare(`SELECT w.runtime,w.id,w.path,w.branch,w.root,w.state,COALESCE(s.title,w.title) AS title,
      COALESCE(s.updated_at,w.updated_at) AS updatedAt,(s.id IS NULL OR s.removed_at IS NOT NULL) AS hidden
      FROM session_worktrees w LEFT JOIN sessions s USING(runtime,id)`).all() as unknown as
      (SessionWorktreeRecord & { title: string | null; updatedAt: number | null; hidden: boolean })[]
  }

  storageCache(): { count: number; bytes: number } {
    return { ...this.#db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(body_bytes),0) AS bytes FROM sessions WHERE body='cached'").get() } as unknown as { count: number; bytes: number }
  }

  /** Include conversations in subfolders even if their managed inventory is still being recorded. */
  storageOwners(path: string): readonly { runtime: RuntimeId; id: SessionId; updatedAt: number }[] {
    return this.#db.prepare(`SELECT runtime,id,updated_at AS updatedAt FROM sessions WHERE cwd=? OR substr(cwd,1,length(?)+1)=? || '/'`)
      .all(path, path, path) as unknown as { runtime: RuntimeId; id: SessionId; updatedAt: number }[]
  }

  worktree(runtime: RuntimeId, id: SessionId): SessionWorktreeRecord | null {
    return this.#db.prepare('SELECT * FROM session_worktrees WHERE runtime=? AND id=?').get(runtime, id) as unknown as SessionWorktreeRecord ?? null
  }

  rememberWorktree(record: SessionWorktreeRecord): void {
    const previous = this.worktree(record.runtime, record.id)
    if (previous && previous.path === record.path && previous.branch === record.branch && previous.root === record.root && previous.state === record.state) return
    this.#transaction(() => {
      this.#db.prepare(`INSERT INTO session_worktrees(runtime,id,path,branch,root,state) VALUES(?,?,?,?,?,?)
        ON CONFLICT(runtime,id) DO UPDATE SET path=excluded.path,branch=excluded.branch,root=excluded.root,state=excluded.state`)
        .run(record.runtime, record.id, record.path, record.branch, record.root, record.state)
      this.#db.prepare(`UPDATE session_worktrees SET title=(SELECT title FROM sessions WHERE runtime=? AND id=?),
        updated_at=(SELECT updated_at FROM sessions WHERE runtime=? AND id=?) WHERE runtime=? AND id=? AND EXISTS(SELECT 1 FROM sessions WHERE runtime=? AND id=?)`)
        .run(record.runtime,record.id,record.runtime,record.id,record.runtime,record.id,record.runtime,record.id)
      this.#db.prepare('UPDATE sessions SET worktree_path=?,worktree_branch=?,worktree_state=? WHERE runtime=? AND id=?')
        .run(record.path, record.branch, record.state, record.runtime, record.id)
    })
    this.#notify(record.runtime, record.id, false)
  }

  worktreeState(path: string, state: SessionWorktreeRecord['state'], branch?: string | null): void {
    const records = this.#db.prepare('SELECT * FROM session_worktrees WHERE path=?').all(path) as unknown as SessionWorktreeRecord[]
    for (const record of records) this.rememberWorktree({ ...record, state, ...(branch === undefined ? {} : { branch }) })
  }

  worktreeInUse(path: string): boolean {
    return !!this.#db.prepare(`SELECT 1 FROM sessions WHERE (cwd=? OR substr(cwd,1,length(?)+1)=? || '/')
      AND removed_at IS NULL AND (archived IS NULL OR archived=0) LIMIT 1`).get(path, path, path)
  }

  managedCandidates(stateDir: string): readonly { runtime: RuntimeId; id: SessionId }[] {
    const prefix = stateDir.replace(/\/$/, '') + '/worktrees/'
    return this.#db.prepare('SELECT runtime,id FROM sessions WHERE removed_at IS NULL AND substr(cwd,1,length(?))=?')
      .all(prefix, prefix) as unknown as { runtime: RuntimeId; id: SessionId }[]
  }

  removalTime(runtime: RuntimeId, id: SessionId): number | null { return this.#row(runtime, id)?.removed_at ?? null }

  expiredWorktrees(before: number): readonly { runtime: RuntimeId; id: SessionId }[] {
    return this.#db.prepare(`SELECT s.runtime,s.id FROM sessions s JOIN session_worktrees w USING(runtime,id)
      WHERE removed_at<=? AND w.state='present'`).all(before) as unknown as { runtime: RuntimeId; id: SessionId }[]
  }

  teamMembers(team: string): readonly SessionSummary[] {
    return (this.#db.prepare(`${SELECT} WHERE s.team_id=? AND s.removed_at IS NULL`).all(team) as unknown as Row[]).map(summaryOf)
  }

  setCwd(runtime: RuntimeId, id: SessionId, cwd: string): void {
    this.#db.prepare('UPDATE sessions SET cwd=? WHERE runtime=? AND id=?').run(cwd, runtime, id)
    this.#notify(runtime, id)
  }

  hasMissingFolders(runtime: RuntimeId): boolean {
    return !!this.#db.prepare("SELECT 1 FROM sessions WHERE runtime=? AND cwd='' AND removed_at IS NULL LIMIT 1").get(runtime)
  }

  /** Agent observations repair old metadata; they never rename or move known rows. */
  fillMissingMetadata(row: Pick<SessionSummary, 'runtime' | 'id' | 'cwd' | 'title'>): boolean {
    const previous = this.#row(row.runtime, row.id)
    if (!previous || previous.removed_at !== null || previous.cwd !== '') return false
    const title = this.#facts(row.runtime, row.id).title
    const result = this.#db.prepare(`UPDATE sessions SET cwd=?,repo_root=(SELECT repo_root FROM repos WHERE cwd=?),
      title=COALESCE(title,?) WHERE runtime=? AND id=? AND cwd='' AND removed_at IS NULL`)
      .run(row.cwd, row.cwd, title === undefined ? row.title ?? null : title, row.runtime, row.id)
    if (result.changes) this.#notify(row.runtime, row.id)
    return result.changes > 0 && row.cwd !== ''
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
    if (this.#closed || options.signal?.aborted || this.#db.prepare("SELECT 1 FROM meta WHERE key='seed:transcripts:previews:v1'").get()) return Promise.resolve()
    if (this.#seeding) return this.#seeding
    this.#seeding = this.#seed(stateDir, options).finally(() => { this.#seeding = null })
    return this.#seeding
  }

  async #seed(stateDir: string, options: SessionIndexSeedOptions): Promise<void> {
    const seeded = !!this.#db.prepare("SELECT 1 FROM meta WHERE key='seed:transcripts:v1'").get()
    for await (const batch of seedSummaries(stateDir)) {
      if (this.#closed || options.signal?.aborted) return
      const inserted: SessionSummary[] = []
      this.#transaction(() => {
        for (const summary of batch) {
          // Live writes, prior batches and deletion tombstones always win.
          if (this.isRemoved(summary.runtime, summary.id)) continue
          const previous = this.#row(summary.runtime, summary.id)
          if (previous) {
            if (previous.title === null && previous.preview === null && summary.preview) {
              this.#db.prepare('UPDATE sessions SET preview=? WHERE runtime=? AND id=? AND title IS NULL AND preview IS NULL AND removed_at IS NULL')
                .run(summary.preview, summary.runtime, summary.id)
              inserted.push(summary)
            }
            continue
          }
          if (seeded) continue
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
    if (!this.#closed && !options.signal?.aborted) this.#transaction(() => {
      this.#db.prepare("INSERT INTO meta(key,value) VALUES('seed:transcripts:v1','1') ON CONFLICT DO NOTHING").run()
      this.#db.prepare("INSERT INTO meta(key,value) VALUES('seed:transcripts:previews:v1','1') ON CONFLICT DO NOTHING").run()
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#pending.clear()
    this.#db.close()
  }
}
