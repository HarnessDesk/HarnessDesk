import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

/**
 * Opens a SQLite file another application owns, for reading, without writing
 * a byte beside it.
 *
 * A plain read-only open is not enough. A database in WAL mode keeps its
 * readers' shared memory in a `-shm` file, and when that file is missing — the
 * owner is not running — a read-only open **creates** it, and a `-wal` with it,
 * in the owner's folder (measured on Node 25.9: `t.db` became `t.db`,
 * `t.db-shm`, `t.db-wal`). So the mode is read from the file's own header:
 *
 * - **WAL, owner running** (`-shm` present): an ordinary read-only open, which
 *   maps the owner's shared memory and sees what it has committed.
 * - **WAL, owner not running**: opened `immutable`, which takes no locks and
 *   creates nothing. Safe exactly because nothing is writing it.
 * - **Rollback journal**: an ordinary read-only open, which only takes a shared
 *   lock and never creates a file.
 *
 * Null when the file is absent, is not a SQLite database, or cannot be opened.
 */
export const openForeignDatabase = (path: string): DatabaseSync | null => {
  if (!existsSync(path)) return null
  const mode = journalOf(path)
  if (mode === null) return null
  try {
    if (mode === 'wal' && !existsSync(`${path}-shm`)) {
      const url = pathToFileURL(path)
      url.searchParams.set('immutable', '1')
      return new DatabaseSync(url.href, { readOnly: true })
    }
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
}

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
