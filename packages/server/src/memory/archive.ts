import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink, readdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

/**
 * Durable, content-addressed citation snapshots.
 *
 * The whole point of retention is durable-before-reference ordering: bytes
 * land on disk, synced, before anything ever points at them, so a crash
 * between the two leaves an orphan file rather than a citation pointing at
 * nothing. `retain` is that whole algorithm, and it is the one place a
 * citation's bytes are ever written — `folder` is always a path already
 * admitted under machine state, never anything a repository supplied.
 */

const MAX_SNAPSHOT_BYTES = 9 * 1024 * 1024

export class CitationArchive {
  private tail: Promise<void> = Promise.resolve()
  private folder: string
  constructor(folder: string) {
    this.folder = folder
  }

  async retain(bytes: string, attach: (key: string) => Promise<void>): Promise<string> {
    if (Buffer.byteLength(bytes) > MAX_SNAPSHOT_BYTES) throw new Error('Citation snapshot is too large.')
    const key = createHash('sha256').update(bytes).digest('hex')
    const operation = this.tail.then(async () => {
      await mkdir(this.folder, { recursive: true, mode: 0o700 })
      if (!(await lstat(this.folder)).isDirectory()) throw new Error('Citation archive is not a directory.')
      const target = join(this.folder, `${key}.json`)
      let exists = false
      try {
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          if (!(await handle.stat()).isFile() || (await handle.stat()).size > MAX_SNAPSHOT_BYTES) {
            throw new Error('Citation archive entry is invalid.')
          }
          if ((await handle.readFile('utf8')) !== bytes) throw new Error('Citation archive entry is damaged.')
          exists = true
        } finally {
          await handle.close()
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (!exists) {
        const temporary = join(this.folder, `.${randomUUID()}.tmp`)
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(bytes, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        try {
          await rename(temporary, target)
          const directory = await open(this.folder, 'r')
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        } finally {
          await unlink(temporary).catch(() => undefined)
        }
      }
      await attach(key)
    })
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    )
    await operation
    return key
  }

  /**
   * Reads one retained snapshot back by its key, verifying that its bytes
   * still hash to the name they are filed under — the same no-follow,
   * bounded read every other reader in this codebase uses, because a key
   * this class did not itself just mint is exactly as untrusted as any other
   * filename a caller might ask for.
   *
   * Hash integrity is not authentication: it proves the bytes were not
   * corrupted or swapped for a different key's content, never that they were
   * written by this install's own `retain` rather than planted by a restore.
   * Callers needing that distinction use the registry `MemoryPlane` builds
   * from `register`, not this method.
   */
  async read(key: string): Promise<string | null> {
    if (!/^[a-f0-9]{64}$/.test(key)) return null
    const target = join(this.folder, `${key}.json`)
    let handle
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ELOOP') return null
      throw error
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return null
      const text = await handle.readFile('utf8')
      if (createHash('sha256').update(text).digest('hex') !== key) return null
      return text
    } finally {
      await handle.close()
    }
  }

  /** Archive-owned temporary files a crash left behind — never anything else in the folder. */
  async sweepOrphanedTemporaries(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.folder)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      if (!name.startsWith('.') || !name.endsWith('.tmp')) continue
      const path = join(this.folder, name)
      const info = await lstat(path).catch(() => null)
      if (info && !info.isSymbolicLink() && info.isFile()) await unlink(path).catch(() => undefined)
    }
  }
}
