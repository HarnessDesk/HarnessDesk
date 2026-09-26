import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The ledger's store.
 *
 * `node:sqlite` ships with the runtime, so a month of per-day, per-model,
 * per-project usage costs no dependency. Rows hold **tokens**, and cost is
 * computed at query time from the price table, so correcting a rate never
 * means rescanning three gigabytes of transcripts. The one cost a row keeps is
 * one the agent itself reported — OpenCode's and Cline's — because that is a
 * fact about what was billed, not a rate anybody could correct.
 *
 * Rows carry the file they came from. An append-only transcript resumes from
 * its byte offset; one that was truncated or rewritten has its rows dropped
 * and is read again, which is only possible because the file is part of the key.
 */

export interface UsageRow {
  readonly file: string
  /** Local midnight of the bucket, epoch milliseconds. */
  readonly day: number
  readonly runtime: string
  readonly model: string
  /** Absolute path of the working directory the turn ran in; '' when unknown. */
  readonly project: string
  /** Uncached input tokens. Every scanner normalises to this. */
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** Part of `output` for most providers; kept for display, never priced twice. */
  readonly reasoning: number
  readonly requests: number
  /**
   * USD the agent itself says these requests cost, when it says; null when
   * the cost is ours to work out from the tokens.
   */
  readonly vendorCost?: number | null
}

export interface FileCursor {
  readonly path: string
  readonly size: number
  readonly mtime: number
  /** Bytes already folded into the rows. */
  readonly offset: number
  /** The last few message ids seen, so a resume cannot count one twice. */
  readonly tail: readonly string[]
}

export interface Totals {
  readonly tokens: number
  readonly cost: number | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  tail TEXT NOT NULL DEFAULT '[]',
  scannedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  file TEXT NOT NULL,
  day INTEGER NOT NULL,
  runtime TEXT NOT NULL,
  model TEXT NOT NULL,
  project TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cacheRead INTEGER NOT NULL DEFAULT 0,
  cacheWrite INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  vendorCost REAL,
  -- 1 when the agent priced these requests. Part of the key, because a row is a
  -- sum, and a sum of requests the agent priced and requests it did not has no
  -- honest cost or provenance.
  vendored INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (file, day, runtime, model, project, vendored)
);
CREATE INDEX IF NOT EXISTS usage_day ON usage (day);
CREATE INDEX IF NOT EXISTS usage_runtime_day ON usage (runtime, day);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

export class LedgerStore {
  readonly #db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec(SCHEMA)
    this.#migrate()
  }

  /**
   * A ledger written before rows could carry an agent's own cost has no
   * `vendorCost`, and one written before that cost was part of the key has a key
   * too narrow to keep priced and unpriced requests apart. Either is rebuilt in
   * place with its rows: empty where the column is new, which is what those
   * rows meant, and unvendored unless they carry a cost.
   */
  #migrate(): void {
    const columns = new Set(
      (this.#db.prepare('PRAGMA table_info(usage)').all() as { name?: unknown }[]).map((column) => column.name),
    )
    if (columns.has('vendored')) return
    const carried = columns.has('vendorCost')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.exec('DROP INDEX IF EXISTS usage_day; DROP INDEX IF EXISTS usage_runtime_day')
      this.#db.exec('ALTER TABLE usage RENAME TO usage_old')
      this.#db.exec(SCHEMA)
      this.#db.exec(`
        INSERT INTO usage (file, day, runtime, model, project, input, output, cacheRead, cacheWrite, reasoning, requests, vendorCost, vendored)
        SELECT file, day, runtime, model, project, input, output, cacheRead, cacheWrite, reasoning, requests,
          ${carried ? 'vendorCost' : 'NULL'}, ${carried ? 'CASE WHEN vendorCost IS NULL THEN 0 ELSE 1 END' : '0'}
        FROM usage_old
      `)
      this.#db.exec('DROP TABLE usage_old')
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.#db.close()
  }

  meta(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  cursor(path: string): FileCursor | null {
    const row = this.#db.prepare('SELECT * FROM files WHERE path = ?').get(path) as
      | { path: string; size: number; mtime: number; offset: number; tail: string }
      | undefined
    if (!row) return null
    let tail: string[] = []
    try {
      const parsed: unknown = JSON.parse(row.tail)
      if (Array.isArray(parsed)) tail = parsed.filter((entry): entry is string => typeof entry === 'string')
    } catch {
      tail = []
    }
    return { path: row.path, size: row.size, mtime: row.mtime, offset: row.offset, tail }
  }

  /** One file's new rows, folded in atomically with its cursor. */
  commit(cursor: FileCursor, rows: readonly UsageRow[], scannedAt: number, replace: boolean): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (replace) this.#db.prepare('DELETE FROM usage WHERE file = ?').run(cursor.path)
      const add = this.#db.prepare(`
        INSERT INTO usage (file, day, runtime, model, project, input, output, cacheRead, cacheWrite, reasoning, requests, vendorCost, vendored)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file, day, runtime, model, project, vendored) DO UPDATE SET
          input = input + excluded.input,
          output = output + excluded.output,
          cacheRead = cacheRead + excluded.cacheRead,
          cacheWrite = cacheWrite + excluded.cacheWrite,
          reasoning = reasoning + excluded.reasoning,
          requests = requests + excluded.requests,
          vendorCost = CASE
            WHEN vendorCost IS NULL AND excluded.vendorCost IS NULL THEN NULL
            ELSE COALESCE(vendorCost, 0) + COALESCE(excluded.vendorCost, 0)
          END
      `)
      for (const row of rows) {
        add.run(
          row.file,
          row.day,
          row.runtime,
          row.model,
          row.project,
          row.input,
          row.output,
          row.cacheRead,
          row.cacheWrite,
          row.reasoning,
          row.requests,
          row.vendorCost ?? null,
          row.vendorCost === null || row.vendorCost === undefined ? 0 : 1,
        )
      }
      this.#db
        .prepare(
          `INSERT INTO files (path, size, mtime, offset, tail, scannedAt) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
             offset = excluded.offset, tail = excluded.tail, scannedAt = excluded.scannedAt`,
        )
        .run(cursor.path, cursor.size, cursor.mtime, cursor.offset, JSON.stringify(cursor.tail), scannedAt)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Every row in the window, for the caller to price and group. */
  since(day: number, runtime?: string): readonly UsageRow[] {
    const sql = runtime
      ? 'SELECT * FROM usage WHERE day >= ? AND runtime = ?'
      : 'SELECT * FROM usage WHERE day >= ?'
    const statement = this.#db.prepare(sql)
    const rows = runtime ? statement.all(day, runtime) : statement.all(day)
    return rows as unknown as UsageRow[]
  }

  /** How many distinct days in the window carry any usage at all. */
  daysCovered(day: number, runtime?: string): number {
    const sql = runtime
      ? 'SELECT COUNT(DISTINCT day) AS n FROM usage WHERE day >= ? AND runtime = ?'
      : 'SELECT COUNT(DISTINCT day) AS n FROM usage WHERE day >= ?'
    const statement = this.#db.prepare(sql)
    const row = (runtime ? statement.get(day, runtime) : statement.get(day)) as { n?: number } | undefined
    return row?.n ?? 0
  }

  /**
   * The earliest day this scope has any row for, unwindowed — a scan horizon,
   * not a query result. `null` when nothing has been recorded for the scope
   * at all, which a caller reads as "no record yet" rather than "zero spent".
   */
  earliestDay(runtime?: string): number | null {
    const sql = runtime
      ? 'SELECT MIN(day) AS day FROM usage WHERE runtime = ?'
      : 'SELECT MIN(day) AS day FROM usage'
    const statement = this.#db.prepare(sql)
    const row = (runtime ? statement.get(runtime) : statement.get()) as { day?: number | null } | undefined
    return typeof row?.day === 'number' ? row.day : null
  }
}
