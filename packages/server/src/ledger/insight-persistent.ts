import { randomUUID, createHash } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ScanTarget } from './scan.js'
import type { UsageSample } from './insight.js'

/** Disposable cache; the source corpus remains the authority. Limits are admission targets, not filesystem quotas. */
const SOURCE_BYTES = 16 * 1024 * 1024
const TOTAL_BYTES = 128 * 1024 * 1024

/** Create or open only a private regular cache file; never follow an existing symlink. */
const privateFile = (path: string): string => {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('cache path is a symlink') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const file = fstatSync(fd)
    if (!file.isFile() || file.nlink !== 1 || (typeof process.getuid === 'function' && file.uid !== process.getuid())) throw new Error('cache path is not an owned regular file')
    if (process.platform !== 'win32') fchmodSync(fd, 0o600)
  } finally { closeSync(fd) }
  return path
}

export interface PersistentEntry {
  readonly target: ScanTarget
  readonly offset: number
  readonly tail: readonly string[]
  readonly samples: readonly UsageSample[]
  readonly limited: boolean
}

// JSON normally collapses -0 into 0; preserve the scanner's exact finite numeric observations.
const zeroTag = '__hd_insight_negative_zero__'
const encodeSample = (sample: UsageSample): string => JSON.stringify(sample, (_key, value: unknown) =>
  typeof value === 'number' && Object.is(value, -0) ? { [zeroTag]: true } : value)
export const decodeSample = (payload: string): UsageSample => {
  // The canonical encoder writes the marker literally. Most observations do not
  // contain -0, and need no per-property reviver; a literal marker in ordinary
  // string data takes the slower path without changing that string.
  if (!payload.includes(zeroTag)) return JSON.parse(payload) as UsageSample
  return JSON.parse(payload, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const row = value as Record<string, unknown>
      if (Object.keys(row).length === 1 && row[zeroTag] === true) return -0
    }
    return value
  }) as UsageSample
}

export const sourceKey = (target: ScanTarget): string => createHash('sha256').update(JSON.stringify([target.runtime, target.kind, target.path])).digest('hex')

/** Only recognized scanner state is stored. Other formats miss safely until their cursors have a safe projection. */
const safeTail = (entry: PersistentEntry): readonly string[] | null => {
  if (entry.target.kind === 'codex') {
    if (entry.tail.length !== 1) return null
    try {
      const value: unknown = JSON.parse(entry.tail[0]!)
      if (!value || typeof value !== 'object') return null
      const state = value as Record<string, unknown>
      if (typeof state.model !== 'string' || typeof state.project !== 'string' || typeof state.followsCompaction !== 'boolean' ||
        (state.sessionId !== undefined && typeof state.sessionId !== 'string')) return null
      return [JSON.stringify({ model: state.model, project: state.project, followsCompaction: state.followsCompaction,
        ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }) })]
    } catch { return null }
  }
  if (entry.target.kind === 'claude' || entry.target.kind === 'qwen') {
    const prefix = '\u0000pending-turns:'
    const result: string[] = []
    for (const item of entry.tail) {
      if (/^[0-9a-f]{64}$/.test(item)) { result.push(item); continue }
      if (!item.startsWith(prefix)) return null
      try {
        const turns: unknown = JSON.parse(item.slice(prefix.length))
        if (!Array.isArray(turns)) return null
        const safe = turns.map((one: unknown) => {
          if (!one || typeof one !== 'object') throw new Error('invalid pending turn')
          const turn = one as Record<string, unknown>
          if (turn.kind !== 'turn' || typeof turn.at !== 'number' || !Number.isFinite(turn.at) || typeof turn.project !== 'string' ||
            (turn.count !== undefined && (typeof turn.count !== 'number' || !Number.isSafeInteger(turn.count) || turn.count <= 0))) throw new Error('invalid pending turn')
          return { kind: 'turn', at: turn.at, project: turn.project, ...(turn.count === undefined ? {} : { count: turn.count }) }
        })
        result.push(prefix + JSON.stringify(safe))
      } catch { return null }
    }
    return result
  }
  return entry.tail.length === 0 ? [] : null
}

export class PersistentInsight {
  #lock: DatabaseSync | null = null
  #db: DatabaseSync | null = null
  #leased = false
  readonly #pinned = new Set<string>()
  readonly #touched = new Map<string, number>()
  readonly #limit: number
  constructor(readonly stateDir: string, limit = TOTAL_BYTES) { this.#limit = limit }

  /** Exclusive only among cooperating cache users. Busy or damaged cache never blocks the real reader. */
  acquire(): boolean {
    try {
      this.#lock ??= new DatabaseSync(privateFile(join(this.stateDir, 'insight-pass-lock.sqlite')))
      this.#lock.exec('PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY)')
      this.#lock.exec('BEGIN IMMEDIATE')
      this.#leased = true
      this.#db ??= new DatabaseSync(privateFile(join(this.stateDir, 'insight-cache-v2.sqlite')))
      this.#db.exec(`PRAGMA busy_timeout = 0; PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY, source TEXT NOT NULL, entry TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL, used INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS generations_source ON generations(source);
        CREATE TABLE IF NOT EXISTS observations (generation TEXT NOT NULL, ordinal INTEGER NOT NULL, project TEXT, runtime TEXT NOT NULL, session TEXT, at REAL, payload TEXT NOT NULL, PRIMARY KEY(generation, ordinal));
        CREATE INDEX IF NOT EXISTS observations_lookup ON observations(project, runtime, session, generation, ordinal);
        CREATE TABLE IF NOT EXISTS published (source TEXT PRIMARY KEY, generation TEXT NOT NULL);`)
      return true
    } catch {
      this.release()
      return false
    }
  }

  release(): void {
    // Every touched generation stays pinned through this lease, so one best-effort
    // transaction can refresh LRU order without a synchronous write on every get.
    if (this.#leased && this.#db && this.#touched.size) {
      try {
        this.#db.exec('BEGIN IMMEDIATE')
        const update = this.#db.prepare('UPDATE generations SET used = ? WHERE id = ?')
        for (const [id, at] of this.#touched) update.run(at, id)
        this.#db.exec('COMMIT')
      } catch { try { this.#db.exec('ROLLBACK') } catch {} }
    }
    if (this.#leased) { try { this.#lock?.exec('ROLLBACK') } catch {} }
    this.#leased = false
    this.#pinned.clear()
    this.#touched.clear()
  }

  close(): void {
    this.release()
    try { this.#db?.close() } catch {}
    try { this.#lock?.close() } catch {}
    this.#db = null; this.#lock = null
  }

  get(target: ScanTarget, selected: (project: string | null) => boolean, generation?: string): { entry: PersistentEntry; generation: string } | null {
    if (!this.#leased || !this.#db) return null
    try {
      const row = (generation
        ? this.#db.prepare('SELECT id, entry, digest FROM generations WHERE id = ? AND source = ?').get(generation, sourceKey(target))
        : this.#db.prepare('SELECT g.id, g.entry, g.digest FROM published p JOIN generations g ON g.id = p.generation WHERE p.source = ?').get(sourceKey(target))) as { id?: unknown; entry?: unknown; digest?: unknown } | undefined
      if (typeof row?.id !== 'string' || typeof row.entry !== 'string' || typeof row.digest !== 'string') return null
      const entry = JSON.parse(row.entry) as PersistentEntry
      if (!entry || !entry.target || !Array.isArray(entry.tail) || typeof entry.offset !== 'number' ||
        typeof entry.limited !== 'boolean' || sourceKey(entry.target) !== sourceKey(target)) return null
      const hash = createHash('sha256').update(row.entry)
      const samples: UsageSample[] = []
      const rows = this.#db.prepare('SELECT project, payload FROM observations WHERE generation = ? ORDER BY ordinal').iterate(row.id) as Iterable<{ project: string | null; payload: string }>
      for (const observation of rows) {
        hash.update('\0').update(JSON.stringify(observation.project)).update('\0').update(observation.payload)
        if (selected(observation.project)) samples.push(decodeSample(observation.payload))
      }
      if (hash.digest('hex') !== row.digest) return null
      this.#pinned.add(row.id)
      this.#touched.set(row.id, Date.now())
      return { entry: { ...entry, samples }, generation: row.id }
    } catch { return null }
  }

  put(entry: PersistentEntry, baseGeneration?: string): boolean {
    if (!this.#leased || !this.#db) return false
    const tail = safeTail(entry)
    if (!tail) return false
    const { samples, ...metadata } = entry
    const data = JSON.stringify({ ...metadata, tail })
    const id = randomUUID(); const key = sourceKey(entry.target)
    try {
      this.#db.exec('BEGIN IMMEDIATE')
      const stale = this.#db.prepare('SELECT id FROM generations WHERE id NOT IN (SELECT generation FROM published)').all() as { id: string }[]
      for (const old of stale) {
        if (this.#pinned.has(old.id)) continue
        this.#db.prepare('DELETE FROM observations WHERE generation = ?').run(old.id)
        this.#db.prepare('DELETE FROM generations WHERE id = ?').run(old.id)
      }
      let ordinal = 0
      if (baseGeneration) {
        this.#db.prepare('INSERT INTO observations SELECT ?, ordinal, project, runtime, session, at, payload FROM observations WHERE generation = ?').run(id, baseGeneration)
        const count = this.#db.prepare('SELECT COUNT(*) AS n FROM observations WHERE generation = ?').get(id) as { n: number }
        ordinal = count.n
      }
      const insert = this.#db.prepare('INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const sample of samples) insert.run(id, ordinal++, sample.project, sample.runtime, sample.sessionId, sample.from, encodeSample(sample))
      const hash = createHash('sha256').update(data)
      let bytes = Buffer.byteLength(data)
      const rows = this.#db.prepare('SELECT project, payload FROM observations WHERE generation = ? ORDER BY ordinal').iterate(id) as Iterable<{ project: string | null; payload: string }>
      for (const observation of rows) {
        const project = JSON.stringify(observation.project)
        hash.update('\0').update(project).update('\0').update(observation.payload)
        bytes += Buffer.byteLength(project) + Buffer.byteLength(observation.payload)
      }
      if (bytes > SOURCE_BYTES || bytes > this.#limit) { this.#db.exec('ROLLBACK'); return false }
      let used = (this.#db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM generations').get() as { bytes: number }).bytes
      if (used + bytes > this.#limit) {
        const victims = this.#db.prepare('SELECT id, bytes FROM generations ORDER BY used, id').all() as { id: string; bytes: number }[]
        for (const victim of victims) {
          if (used + bytes <= this.#limit) break
          if (this.#pinned.has(victim.id)) continue
          this.#db.prepare('DELETE FROM published WHERE generation = ?').run(victim.id)
          this.#db.prepare('DELETE FROM observations WHERE generation = ?').run(victim.id)
          this.#db.prepare('DELETE FROM generations WHERE id = ?').run(victim.id)
          used -= victim.bytes
        }
      }
      if (used + bytes > this.#limit) { this.#db.exec('ROLLBACK'); return false }
      this.#db.prepare('INSERT INTO generations VALUES (?, ?, ?, ?, ?, ?)').run(id, key, data, hash.digest('hex'), bytes, Date.now())
      this.#db.prepare('INSERT INTO published VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET generation=excluded.generation').run(key, id)
      this.#db.exec('COMMIT')
      this.#pinned.add(id)
      return true
    } catch { try { this.#db.exec('ROLLBACK') } catch {}; return false }
  }
}
