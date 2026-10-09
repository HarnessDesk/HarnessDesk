import { readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StorageUsage } from '@harnessdesk/protocol'
import type { SessionIndex } from './session-index.js'
import { diskBytes } from './storage-walk.js'

/** One lazy background measurement per host, explicitly invalidated after cleanup. */
export class Storage {
  #measured: Omit<StorageUsage, 'cachedPreviews'> | null = null
  #running: Promise<void> | null = null
  #closed = false
  constructor(private readonly index: SessionIndex, private readonly home: string,
    private readonly changed: (usage: StorageUsage) => void) {}

  usage(): StorageUsage {
    if (!this.#measured && !this.#running && !this.#closed) {
      // Let the method answer before a directory read or traversal begins.
      this.#running = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.#measure()).finally(() => { this.#running = null })
    }
    return { ...(this.#measured ?? {
      database: { bytes: 0, computing: true }, snapshots: { count: 0, bytes: 0, computing: true },
      worktrees: { count: 0, bytes: 0, kept: 0, computing: true },
    }), cachedPreviews: this.index.storageCache() }
  }

  async #measure(): Promise<void> {
    const errorOf = (error: unknown) => error instanceof Error ? error.message : String(error)
    const size = async (path: string) => { try { return (await lstat(path)).size } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error } }
    let database: StorageUsage['database'], snapshots: StorageUsage['snapshots'], worktrees: StorageUsage['worktrees']
    try {
      let bytes = 0
      for (const suffix of ['', '-wal', '-shm']) bytes += await size(join(this.home, `sessions.sqlite${suffix}`))
      database = { bytes, computing: false }
    } catch (error) { database = { bytes: 0, computing: false, error: errorOf(error) } }
    try {
      const files = (await readdir(this.home)).filter(name => /^sessions-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
      let bytes = 0
      for (const name of files) bytes += await size(join(this.home, name))
      snapshots = { count: files.length, bytes, computing: false }
    } catch (error) { snapshots = { count: 0, bytes: 0, computing: false, error: errorOf(error) } }
    const kept = new Set(this.index.storageWorktrees().filter(row => row.state === 'kept').map(row => row.path)).size
    try {
      const home = join(this.home, 'worktrees')
      let count = 0
      for (const container of await readdir(home, { withFileTypes: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error })) {
        if (!container.isDirectory()) continue
        for (const tree of await readdir(join(home, container.name), { withFileTypes: true })) if (tree.isDirectory()) count++
      }
      worktrees = { count, kept, bytes: await diskBytes(home), computing: false }
    } catch (error) { worktrees = { count: 0, bytes: 0, kept, computing: false, error: errorOf(error) } }
    if (this.#closed) return
    this.#measured = { database, snapshots, worktrees }
    this.changed(this.usage())
  }

  async refresh(): Promise<void> {
    await this.#running
    this.#measured = null
    this.usage()
  }
  async close(): Promise<void> { this.#closed = true; await this.#running }
}
