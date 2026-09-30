import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

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
  /**
   * One person-or-agent prompt answered by the agent — never an API request
   * or a tool call, and never this row's own `requests`. Optional, and
   * `null` in the store proper is not the same 0 a scanner actually counted:
   * a row a turn-capable scanner wrote always carries a real integer (0 or
   * more); `null` is what a row from before turns existed reads as, until
   * the file it came from is scanned again — see the store's own migration
   * comment, and `SpendCoverage.turnsKnownFor`, which is what tells a real
   * zero apart from "never counted".
   */
  readonly turns?: number | null
}

/** A scanner's call and token totals for one file's local wall-clock hour. */
export interface UsageHourRow {
  readonly file: string
  /** Local midnight of the bucket, epoch milliseconds. */
  readonly day: number
  readonly hour: number
  readonly runtime: string
  readonly requests: number
  readonly tokens: number
}

export interface UsageHourBucket {
  readonly runtime: string
  readonly weekday: number
  readonly hour: number
  readonly requests: number
  readonly tokens: number
}

export interface BalanceHistoryRow {
  readonly at: number
  readonly remaining: number
  readonly unit: string
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
  -- NULL until a scanner with a real turn boundary has actually counted this
  -- row's turns -- never a default 0, which would read as a known real zero
  -- rather than "never scanned for this". See UsageRow.turns above.
  turns INTEGER,
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
CREATE TABLE IF NOT EXISTS balance_history (
  runtime TEXT NOT NULL,
  account TEXT NOT NULL,
  at INTEGER NOT NULL,
  remaining REAL NOT NULL,
  unit TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS balance_history_scope_at ON balance_history (runtime, account, at);
`

const BALANCE_HISTORY_RETENTION_MS = 400 * 24 * 60 * 60 * 1_000
const BALANCE_HISTORY_INTERVAL_MS = 60 * 60 * 1_000

export class LedgerStore {
  readonly #db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec(SCHEMA)
    this.#migrate()
    this.#migrateHours()
  }

  #migrateHours(): void {
    const existed = (this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_hours'").get() !== undefined)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.exec(`CREATE TABLE IF NOT EXISTS usage_hours (
        file TEXT NOT NULL, day INTEGER NOT NULL, hour INTEGER NOT NULL, runtime TEXT NOT NULL,
        requests INTEGER NOT NULL, tokens INTEGER NOT NULL,
        PRIMARY KEY (file, day, hour, runtime)
      ); CREATE INDEX IF NOT EXISTS usage_hours_window ON usage_hours (day, runtime, hour);`)
      if (!existed) {
        const files = this.#db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }
        this.#db.prepare("INSERT INTO meta (key, value) VALUES ('hours:ready', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run()
        if (files.n > 0) {
          // These rows were written by local file cursors without hour buckets.
          // Force a full read; remote rows have no matching cursor and remain intact.
          this.#db.exec('DELETE FROM usage WHERE file IN (SELECT path FROM files)')
          this.#db.exec('DELETE FROM files')
        }
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** False only in the gap after migrating old local rows and before their rescan. */
  hoursReady(): boolean {
    return this.meta('hours:ready') !== '0'
  }

  markHoursReady(): void {
    if (this.meta('hours:ready') === '0') this.setMeta('hours:ready', '1')
  }

  #columns(): Set<unknown> {
    return new Set(
      (this.#db.prepare('PRAGMA table_info(usage)').all() as { name?: unknown }[]).map((column) => column.name),
    )
  }

  /**
   * A ledger written before rows could carry an agent's own cost has no
   * `vendorCost`, and one written before that cost was part of the key has a key
   * too narrow to keep priced and unpriced requests apart. Either is rebuilt in
   * place with its rows: empty where the column is new, which is what those
   * rows meant, and unvendored unless they carry a cost.
   *
   * A ledger written before turns were counted at all simply has no `turns`
   * column, and that one is a plain additive column — no key changes, no row
   * ever needs a different one — so it is added in place rather than rebuilt.
   * It is added nullable, with no default: an existing row never counted a
   * turn, and 0 would say it did, when the honest answer is "unknown until
   * this file is read again". So the same migration also resets every local
   * corpus's file cursor and deletes the rows those cursors cover — the ones
   * `commit()` writes, keyed to a file this machine can still read — which
   * is what turns the very next scan into a full one for exactly the rows
   * that need it, without disturbing a remote source's own rows (Cursor's
   * events, the desk's own transcript fallback), which were never tracked by
   * a file cursor and already re-cover their own window on their own
   * schedule. `turns:ready` starts cleared by the same migration, and
   * `Ledger` marks it once a scan actually completes — see `LedgerStore.
   * turnsReady`/`markTurnsReady` — so a coverage read between the migration
   * and that first scan says "unknown", never a stale, too-low real count.
   */
  #migrate(): void {
    if (!this.#columns().has('vendored')) {
      const carried = this.#columns().has('vendorCost')
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
    if (!this.#columns().has('turns')) {
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        this.#db.exec('ALTER TABLE usage ADD COLUMN turns INTEGER')
        // Every row `commit()` ever wrote is keyed to a file this machine
        // still has a cursor for; deleting those rows and their cursors
        // together is what makes the next scan of that file a full one —
        // `Ledger`'s own scan loop reads `from = 0` the moment a target's
        // cursor is gone. A remote source's rows are never in `files` at
        // all (see `replaceWindow`), so they are untouched here and simply
        // keep whatever their own next sync gives them.
        this.#db.exec('DELETE FROM usage WHERE file IN (SELECT path FROM files)')
        this.#db.exec('DELETE FROM files')
        this.#db
          .prepare("INSERT INTO meta (key, value) VALUES ('turns:ready', '0') ON CONFLICT(key) DO UPDATE SET value = '0'")
          .run()
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
    }
  }

  /**
   * Whether this ledger's turn counts can be trusted at all: `true` for a
   * database that always had the `turns` column (nothing to distrust), and
   * for one that did not until a scan has actually completed since — see
   * the migration's own comment. `false` for the gap in between, which
   * `Ledger` reads as "unknown", the same as a runtime it was never told
   * about.
   */
  turnsReady(): boolean {
    return this.meta('turns:ready') !== '0'
  }

  /** Called once a scan completes; a no-op once the ledger is already ready. */
  markTurnsReady(): void {
    if (this.meta('turns:ready') === '0') this.setMeta('turns:ready', '1')
  }

  close(): void {
    this.#db.close()
  }

  /** Keep a changed balance immediately, otherwise no more than once an hour. */
  recordBalance(runtime: string, account: string, at: number, remaining: number, unit: string): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare('DELETE FROM balance_history WHERE at < ?').run(at - BALANCE_HISTORY_RETENTION_MS)
      const last = this.#db.prepare(`SELECT at, remaining, unit FROM balance_history
        WHERE runtime = ? AND account = ? ORDER BY at DESC, rowid DESC LIMIT 1`).get(runtime, account) as
        | { at: number; remaining: number; unit: string }
        | undefined
      if (!last || last.remaining !== remaining || last.unit !== unit || at - last.at >= BALANCE_HISTORY_INTERVAL_MS) {
        this.#db.prepare('INSERT INTO balance_history (runtime, account, at, remaining, unit) VALUES (?, ?, ?, ?, ?)')
          .run(runtime, account, at, remaining, unit)
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Balance readings for one runtime and account, oldest first. */
  balanceHistory(runtime: string, account: string, since: number): readonly BalanceHistoryRow[] {
    return this.#db.prepare(`SELECT at, remaining, unit FROM balance_history
      WHERE runtime = ? AND account = ? AND at >= ? ORDER BY at, rowid`).all(runtime, account, since) as unknown as BalanceHistoryRow[]
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

  #insertRowStatement(): StatementSync {
    return this.#db.prepare(`
      INSERT INTO usage (file, day, runtime, model, project, input, output, cacheRead, cacheWrite, reasoning, requests, turns, vendorCost, vendored)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file, day, runtime, model, project, vendored) DO UPDATE SET
        input = input + excluded.input,
        output = output + excluded.output,
        cacheRead = cacheRead + excluded.cacheRead,
        cacheWrite = cacheWrite + excluded.cacheWrite,
        reasoning = reasoning + excluded.reasoning,
        requests = requests + excluded.requests,
        turns = CASE
          WHEN turns IS NULL AND excluded.turns IS NULL THEN NULL
          ELSE COALESCE(turns, 0) + COALESCE(excluded.turns, 0)
        END,
        vendorCost = CASE
          WHEN vendorCost IS NULL AND excluded.vendorCost IS NULL THEN NULL
          ELSE COALESCE(vendorCost, 0) + COALESCE(excluded.vendorCost, 0)
        END
    `)
  }

  #insertRow(statement: StatementSync, row: UsageRow): void {
    statement.run(
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
      row.turns ?? 0,
      row.vendorCost ?? null,
      row.vendorCost === null || row.vendorCost === undefined ? 0 : 1,
    )
  }

  /** One file's new rows, folded in atomically with its cursor. */
  commit(cursor: FileCursor, rows: readonly UsageRow[], scannedAt: number, replace: boolean, hours: readonly UsageHourRow[] = []): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (replace) {
        this.#db.prepare('DELETE FROM usage WHERE file = ?').run(cursor.path)
        this.#db.prepare('DELETE FROM usage_hours WHERE file = ?').run(cursor.path)
      }
      const add = this.#insertRowStatement()
      for (const row of rows) this.#insertRow(add, row)
      const addHour = this.#db.prepare(`INSERT INTO usage_hours (file, day, hour, runtime, requests, tokens)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(file, day, hour, runtime) DO UPDATE SET
        requests = requests + excluded.requests, tokens = tokens + excluded.tokens`)
      for (const hour of hours) addHour.run(hour.file, hour.day, hour.hour, hour.runtime, hour.requests, hour.tokens)
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

  /**
   * A remote source's re-sync: replaces every row it holds for `[from, to)`
   * with `rows`, and nothing outside that window. Unlike `commit`'s
   * whole-file replace, a remote source is read incrementally and never
   * re-fetches its own beginning, so wiping the whole file on every sync
   * would throw away every day before the current window. A day the remote
   * source no longer reports — deleted upstream — disappears here exactly
   * because it is not in `rows`; nothing carries it forward.
   */
  replaceWindow(file: string, from: number, to: number, rows: readonly UsageRow[]): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare('DELETE FROM usage WHERE file = ? AND day >= ? AND day < ?').run(file, from, to)
      this.#db.prepare('DELETE FROM usage_hours WHERE file = ? AND day >= ? AND day < ?').run(file, from, to)
      const add = this.#insertRowStatement()
      for (const row of rows) this.#insertRow(add, row)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Sums local hour rows into the requested window's runtime × weekday × hour buckets. */
  hourly(from: number, to: number, runtime?: string): readonly UsageHourBucket[] {
    const statement = this.#db.prepare(`SELECT day, runtime, hour, SUM(requests) AS requests, SUM(tokens) AS tokens
      FROM usage_hours WHERE day >= ? AND day < ? ${runtime === undefined ? '' : 'AND runtime = ?'}
      GROUP BY day, runtime, hour ORDER BY runtime, day, hour`)
    const rows = (runtime === undefined ? statement.all(from, to) : statement.all(from, to, runtime)) as unknown as {
      day: number; runtime: string; hour: number; requests: number; tokens: number
    }[]
    const buckets = new Map<string, UsageHourBucket>()
    for (const row of rows) {
      const weekday = new Date(row.day).getDay()
      const key = `${row.runtime}\u0000${weekday}\u0000${row.hour}`
      const current = buckets.get(key)
      buckets.set(key, {
        runtime: row.runtime,
        weekday,
        hour: row.hour,
        requests: (current?.requests ?? 0) + row.requests,
        tokens: (current?.tokens ?? 0) + row.tokens,
      })
    }
    return [...buckets.values()].sort((a, b) => a.runtime.localeCompare(b.runtime) || a.weekday - b.weekday || a.hour - b.hour)
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
