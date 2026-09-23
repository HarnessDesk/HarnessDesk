import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { InsightBudgetExceededError } from './insight.js'

/**
 * Reads a SQLite file another application owns, without writing a byte beside
 * it and without trusting a guess about who else has it open.
 *
 * A plain read-only open is not enough. A database in WAL mode keeps its
 * readers' shared memory in a `-shm` file, and when that file is missing a
 * read-only open **creates** it, and a `-wal` with it, in the owner's folder
 * (measured on Node 25.9: `t.db` became `t.db`, `t.db-shm`, `t.db-wal`). And
 * the opposite guess is no safer: a `-shm` proves nothing about the owner (a
 * Cline database here has held one since a run that ended weeks ago), and its
 * absence proves nothing either (an owner in exclusive locking mode never
 * makes one). So the mode is read from the file's own header, and the choice
 * follows what is on disk, not who is thought to be running:
 *
 * - **Rollback journal**: an ordinary read-only open, which only takes a shared
 *   lock and never creates a file.
 * - **WAL, and neither `-wal` nor `-shm` beside it**: nothing is pending and
 *   nothing has it open, by SQLite's own rule (the last connection to close
 *   removes both). Opened `immutable`, which takes no locks and creates
 *   nothing. `immutable` skips change detection, so the read is **checked
 *   afterwards**: if the file changed, or a side file appeared, an owner
 *   started while it was being read, and the answer is discarded.
 * - **WAL with a `-wal` or `-shm`**: an owner may be running, or may have died
 *   with commits still in the log. The database and its log are **copied** to a
 *   private folder and read there, so nothing of the owner's is opened, locked
 *   or recreated. The copy is trusted only if the source's size and time were
 *   the same before and after it (a checkpoint or a commit during the copy
 *   changes them), and is retried when they were not.
 *
 * Null when the file is absent or is not a SQLite database. Anything else that
 * stops a read — a file too large to copy, one that kept changing — throws, so
 * a scan reports it instead of replacing its rows with a torn read.
 *
 * Two limits, both deliberate (round 2 review): the consistency check compares
 * size and modification time, not bytes, so a rewrite that lands on the same
 * size and the same millisecond would be missed — neither OpenCode's nor
 * Cline's writer does this, and a byte or version check would cost a read of
 * the file to buy against a case that has not been observed. And a database
 * over `SNAPSHOT_LIMIT_BYTES` that its owner may have open is refused rather
 * than copied, so a very large store stays on its last good rows until it is
 * quiescent or smaller, rather than paying to copy a file that size on every
 * scan.
 *
 * A caller's own byte budget (`byteLimit`) is a third limit, checked against
 * the very same fingerprint every path already takes for its own consistency
 * check — never a separate, earlier look at the file that could go stale by
 * the time this one actually reads it (round 2 review). Whichever path reads
 * the database, growth past what was checked is refused the same way growth
 * past what a copy started from already is: by the check the read was always
 * going to make, not a new one bolted on beside it. `onSize`, called only once
 * a read is known to match the fingerprint it was checked against, reports
 * the bytes that fingerprint actually covered — database plus its
 * write-ahead log — so a caller tracking a shared budget across sources
 * counts what was truly read, not a guess taken before the read happened.
 */
export interface ForeignReadOptions {
  /** Called between copying and checking the source: the race the check exists for. */
  readonly onCopied?: () => void
  /** Refuses before the database is opened for its real read if the fingerprinted size is already more than this. */
  readonly byteLimit?: number
  /** The fingerprinted size (database plus write-ahead log) a consistent read actually spent, once the read is known to match it. */
  readonly onSize?: (size: number) => void
}

/** A snapshot is a copy: past this, reading it costs more than the figure is worth. */
export const SNAPSHOT_LIMIT_BYTES = 1024 * 1024 * 1024
const SNAPSHOT_ATTEMPTS = 3

interface Stamp {
  readonly size: number
  readonly mtimeMs: number
}
interface Fingerprint {
  readonly db: Stamp
  readonly wal: Stamp | null
  readonly shm: boolean
}

export const readForeignDatabase = <T>(
  path: string,
  read: (database: DatabaseSync) => T,
  options: ForeignReadOptions = {},
): T | null => {
  const mode = journalOf(path)
  if (mode === null) return null
  if (mode === 'rollback') return readRollback(path, read, options)
  const first = fingerprint(path)
  if (first === null) return null
  if (first.wal === null && !first.shm) return readQuiescent(path, read, first, options)
  return readSnapshot(path, read, options)
}

const open = (path: string, immutable = false): DatabaseSync => {
  if (!immutable) return new DatabaseSync(path, { readOnly: true })
  const url = pathToFileURL(path)
  url.searchParams.set('immutable', '1')
  return new DatabaseSync(url.href, { readOnly: true })
}

/** Runs the read and always lets go of the connection. */
const readIn = <T>(database: DatabaseSync, read: (database: DatabaseSync) => T): T => {
  try {
    return read(database)
  } finally {
    database.close()
  }
}

/** The database plus its write-ahead log — what a caller's `byteLimit` and `SNAPSHOT_LIMIT_BYTES` both mean by "how large this is". */
const sizeOf = (print: Fingerprint): number => print.db.size + (print.wal?.size ?? 0)

const overBudget = (size: number, options: ForeignReadOptions): boolean =>
  options.byteLimit !== undefined && size > options.byteLimit

/**
 * A rollback-journal file has no `-wal`/`-shm` side files to fingerprint —
 * SQLite takes an ordinary shared lock instead — so the consistency check
 * here is its own: the plain file's size and time, taken before the read and
 * compared after it. Previously unchecked entirely (round 2 review): a
 * database rewritten while its read was in flight was trusted whole.
 */
const readRollback = <T>(path: string, read: (database: DatabaseSync) => T, options: ForeignReadOptions): T => {
  const before = stamp(path)
  if (before === null) throw changed(path)
  if (overBudget(before.size, options)) throw new InsightBudgetExceededError()
  const value = readIn(open(path), read)
  if (!sameStamp(before, stamp(path))) throw changed(path)
  options.onSize?.(before.size)
  return value
}

const readQuiescent = <T>(
  path: string,
  read: (database: DatabaseSync) => T,
  before: Fingerprint,
  options: ForeignReadOptions,
): T => {
  if (overBudget(sizeOf(before), options)) throw new InsightBudgetExceededError()
  let value: T
  try {
    value = readIn(open(path, true), read)
  } catch (error) {
    // A file that moved under an immutable read can fail in any way at all.
    if (!same(before, fingerprint(path))) throw changed(path)
    throw error
  }
  options.onCopied?.()
  if (!same(before, fingerprint(path))) throw changed(path)
  options.onSize?.(sizeOf(before))
  return value
}

const readSnapshot = <T>(path: string, read: (database: DatabaseSync) => T, options: ForeignReadOptions): T => {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
    const before = fingerprint(path)
    if (before === null) throw changed(path)
    if (sizeOf(before) > SNAPSHOT_LIMIT_BYTES) {
      throw new Error(`${path} is too large to read while its owner may have it open`)
    }
    if (overBudget(sizeOf(before), options)) throw new InsightBudgetExceededError()
    const dir = mkdtempSync(join(tmpdir(), 'hd-foreign-'))
    try {
      copyFileSync(path, join(dir, 'db'))
      if (before.wal !== null) copyFileSync(`${path}-wal`, join(dir, 'db-wal'))
      options.onCopied?.()
      if (!same(before, fingerprint(path))) continue
      const value = readIn(open(join(dir, 'db')), read)
      options.onSize?.(sizeOf(before))
      return value
    } catch (error) {
      // The log a checkpoint removes between the check and the copy is that
      // race too, not a fault.
      if (isMissing(error) && !same(before, fingerprint(path))) continue
      throw error
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  throw changed(path)
}

const changed = (path: string): Error => new Error(`${path} changed while it was being read`)

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'

const stamp = (path: string): Stamp | null => {
  try {
    const { size, mtimeMs } = statSync(path)
    return { size, mtimeMs }
  } catch {
    return null
  }
}

/** What "the same file" means for a consistent read: both files' size and time, and whether the shared memory is there. */
const fingerprint = (path: string): Fingerprint | null => {
  const db = stamp(path)
  if (db === null) return null
  return { db, wal: stamp(`${path}-wal`), shm: existsSync(`${path}-shm`) }
}

const sameStamp = (a: Stamp | null, b: Stamp | null): boolean =>
  a === null || b === null ? a === b : a.size === b.size && a.mtimeMs === b.mtimeMs

/** The shared memory is compared only for presence: readers rewrite it without the data changing. */
const same = (a: Fingerprint, b: Fingerprint | null): boolean =>
  b !== null && sameStamp(a.db, b.db) && sameStamp(a.wal, b.wal) && a.shm === b.shm

const HEADER = 'SQLite format 3\u0000'

/**
 * The header's write and read versions (bytes 18 and 19) are 2 for a WAL
 * database and 1 for a rollback-journal one.
 */
const journalOf = (path: string): 'wal' | 'rollback' | null => {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const header = Buffer.alloc(20)
    if (readSync(fd, header, 0, 20, 0) < 20) return null
    if (header.subarray(0, 16).toString('latin1') !== HEADER) return null
    return header[18] === 2 || header[19] === 2 ? 'wal' : 'rollback'
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
