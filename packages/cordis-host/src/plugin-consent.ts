import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { MANIFEST_FILENAME } from './manifest.js'

/**
 * What the person agreed to when they installed each plugin.
 *
 * The host holds an installed plugin to its manifest, and the manifest lives
 * inside the plugin's own directory, where a plugin that reaches the file
 * system can rewrite it. So the host keeps its own record of the manifest the
 * person saw, outside the plugins directory, and a plugin whose manifest no
 * longer matches that record does not start until the person agrees again.
 *
 * The record is a digest of the manifest file's bytes. Any change, a widened
 * permission or a reworded description, counts: the host does not try to
 * decide which edits a person would have minded.
 */

/** Where the record lives: beside the plugins directory, never inside it. */
export const consentPath = (pluginsDirectory: string): string =>
  join(dirname(resolve(pluginsDirectory)), 'plugin-consent.json')

/**
 * - `agreed`: the manifest is the one the person agreed to.
 * - `recorded`: there was no record yet (installed before the record existed), so this one is now it.
 * - `changed`: the manifest differs from the one agreed to; the plugin must not start.
 */
export type ConsentCheck = 'agreed' | 'recorded' | 'changed'

interface Entry {
  readonly manifest: string
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const digestAt = async (directory: string): Promise<string> =>
  digest(await readFile(join(directory, MANIFEST_FILENAME)))

export class ConsentRecord {
  /** Writes are serialised: plugins start in parallel, and two read-modify-writes would lose one. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(readonly path: string) {}

  /** Records the manifest now in `directory` as the one the person agreed to for `id`. */
  record(id: string, directory: string): Promise<void> {
    return this.#serialised(async () => {
      const entries = await this.#read()
      entries[id] = { manifest: await digestAt(directory) }
      await this.#write(entries)
    })
  }

  /**
   * Whether `manifest`, the bytes of the manifest about to be started, is
   * still the one agreed to for `id`. The caller passes the bytes it parsed,
   * so the check and the permissions it starts with describe the same file.
   */
  check(id: string, manifest: Uint8Array): Promise<ConsentCheck> {
    return this.#serialised(async () => {
      const entries = await this.#read()
      const now = digest(manifest)
      const entry = entries[id]
      if (!entry) {
        entries[id] = { manifest: now }
        await this.#write(entries)
        return 'recorded'
      }
      return entry.manifest === now ? 'agreed' : 'changed'
    })
  }

  /**
   * Whether `manifest` is exactly the one agreed to for `id`, without
   * recording anything: a missing entry is not agreement. For checks made
   * while the plugin runs, where a first-time record would be a grant.
   */
  async matches(id: string, manifest: Uint8Array): Promise<boolean> {
    const entry = (await this.#read())[id]
    return entry !== undefined && entry.manifest === digest(manifest)
  }

  /** Forgets `id`, when it is uninstalled. */
  forget(id: string): Promise<void> {
    return this.#serialised(async () => {
      const entries = await this.#read()
      if (!(id in entries)) return
      delete entries[id]
      await this.#write(entries)
    })
  }

  #serialised<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work)
    this.#queue = next.catch(() => undefined)
    return next
  }

  async #read(): Promise<Record<string, Entry>> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      // Only a record that does not exist yet is empty. One that cannot be
      // read is not: treating it as empty would record whatever manifest is
      // on disk now as the one agreed to.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error(`The plugin consent record at ${this.path} cannot be read: ${(error as Error).message}`)
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${this.path} is not a consent record.`)
    }
    const out: Record<string, Entry> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const manifest = (value as { manifest?: unknown } | null)?.manifest
      if (typeof manifest === 'string') out[id] = { manifest }
    }
    return out
  }

  async #write(entries: Record<string, Entry>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    // Written beside and renamed over, so a crash mid-write leaves the old record, not half of one.
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }
}
