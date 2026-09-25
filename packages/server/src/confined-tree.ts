import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

import { NOTHING_HERE } from './errno.js'

/**
 * The one way into a folder whose contents someone else wrote.
 *
 * A project's `.harnessdesk` arrives with a clone, so every byte of it — a
 * planted link, a hard link, a name the desk never chose, a file too large to
 * be a flow — is the repository's, not the person's. Every read and write the
 * flow catalogue, the flow update, its journal and the Agent files it creates
 * make below such a root goes through this module and nowhere else.
 *
 * The threat model is a hostile *static* tree (docs/decisions.md, "A cloned
 * tree is hostile; the person's own processes are not"). A same-user process
 * swapping folders between two calls is out of scope: it can already write
 * anything the person can, and Node's path-only fs API cannot close that race.
 *
 * - The root is resolved once, by `realpath`, and pinned by identity. Every
 *   later call re-reads that identity (one `lstat`) and refuses a root that
 *   was replaced; nothing below it is ever resolved again.
 * - Every open below the root uses macOS's `O_NOFOLLOW_ANY` (no named export
 *   in Node; libuv forwards the number), which refuses a link at any
 *   component, the last one included. Where it does not exist, reads walk
 *   each ancestor with `lstat` first and refuse a link there, and every write
 *   refuses outright: the desk ships on macOS, and a weaker write is not
 *   substituted for the one it was built on.
 * - A file is replaced by writing a synced sibling and renaming it over the
 *   target, then syncing the folder — never by truncating in place — and only
 *   while the target still holds the bytes the caller previewed.
 */

/** macOS `O_NOFOLLOW_ANY`: refuse a symbolic link in any component of the path. */
const NOFOLLOW_ANY = 0x20000000

export interface TreeIdentity {
  readonly dev: string
  readonly ino: string
}

export type TreeEntryKind = 'file' | 'dir' | 'link' | 'other'

export interface TreeEntry {
  readonly name: string
  readonly kind: TreeEntryKind
}

export interface ConfinedTreeOptions {
  /** Tests only: which platform's open to use. The host never sets it. */
  readonly platform?: NodeJS.Platform
  /** Refuse a root whose identity is not this one — a folder replaced since it was pinned. */
  readonly expect?: TreeIdentity
  /** Host-owned roots only (the desk's own state): make the root before resolving it. */
  readonly create?: boolean
}

export type ReplaceOutcome = 'replaced' | 'unchanged' | 'changed'

const errnoOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? '')
const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code })
const identityOf = (info: { readonly dev: bigint; readonly ino: bigint }): TreeIdentity => ({ dev: String(info.dev), ino: String(info.ino) })
const sameIdentity = (left: TreeIdentity, right: TreeIdentity): boolean => left.dev === right.dev && left.ino === right.ino

const linkRefusal = (rel: string): Error =>
  coded(`"${rel}" is reached through a link, so it was not used: files here are only read and written through a real directory.`, 'HD_TREE_LINK')
const rootChanged = (): Error =>
  coded('This folder changed after it was opened, so nothing more was read or written. Open it again.', 'HD_TREE_CHANGED')

/** A path below the root: relative, `/`-separated, no empty, `.` or `..` part, no backslash or NUL. */
const partsOf = (rel: string, root = false): readonly string[] => {
  if (root && rel === '') return []
  const parts = typeof rel === 'string' ? rel.split('/') : []
  if (parts.length === 0 || rel.includes('\\') || rel.includes('\0')
    || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw coded(`"${String(rel)}" is not a path inside this folder.`, 'HD_TREE_PATH')
  }
  return parts
}

const readBounded = async (handle: FileHandle, limit: number): Promise<Buffer> => {
  const bytes = Buffer.alloc(limit + 1)
  let used = 0
  while (used < bytes.length) {
    const read = await handle.read(bytes, used, bytes.length - used, used)
    if (read.bytesRead === 0) break
    used += read.bytesRead
  }
  return bytes.subarray(0, used)
}

export class ConfinedTree {
  /** The canonical root: `realpath`'d once, never again. */
  readonly root: string
  readonly identity: TreeIdentity
  readonly #anyComponent: boolean

  private constructor(root: string, identity: TreeIdentity, anyComponent: boolean) {
    this.root = root
    this.identity = identity
    this.#anyComponent = anyComponent
  }

  static async open(root: string, options: ConfinedTreeOptions = {}): Promise<ConfinedTree> {
    if (options.create) await mkdir(root, { recursive: true })
    const canonical = await realpath(root)
    const info = await lstat(canonical, { bigint: true })
    if (!info.isDirectory()) throw coded('This is not a folder, so nothing inside it was read.', 'ENOTDIR')
    const identity = identityOf(info)
    if (options.expect && !sameIdentity(options.expect, identity)) throw rootChanged()
    return new ConfinedTree(canonical, identity, (options.platform ?? process.platform) === 'darwin')
  }

  /** Whether this platform can write here at all. Without an any-component no-follow open, it cannot. */
  get writable(): boolean {
    return this.#anyComponent
  }

  #mayWrite(): void {
    if (!this.#anyComponent) {
      throw coded('HarnessDesk cannot change files here on this system: it has no open that refuses a link anywhere in a path, so nothing was written.', 'HD_TREE_PLATFORM')
    }
  }

  /** One `lstat` of the pinned root: a replaced root is refused before anything below it is touched. */
  async #checkRoot(): Promise<void> {
    const now = await lstat(this.root, { bigint: true }).catch(() => null)
    if (!now || !now.isDirectory() || !sameIdentity(this.identity, identityOf(now))) throw rootChanged()
  }

  /** Every open below the root. A link anywhere in `parts` is refused, never followed. */
  async #open(parts: readonly string[], flags: number, mode?: number): Promise<FileHandle> {
    const rel = parts.join('/')
    const path = join(this.root, ...parts)
    if (!this.#anyComponent) {
      // Reads only: `#mayWrite` already refused every write on this platform.
      // Each component is looked at without following it, the last one too
      // (`O_NOFOLLOW` with `O_DIRECTORY` answers a link as "not a folder").
      let at = this.root
      for (const [index, part] of parts.entries()) {
        at = join(at, part)
        const info = await lstat(at)
        if (info.isSymbolicLink()) throw linkRefusal(rel)
        if (index < parts.length - 1 && !info.isDirectory()) throw coded(`"${rel}" is not inside a folder.`, 'ENOTDIR')
      }
    }
    try {
      return await open(path, flags | (this.#anyComponent ? NOFOLLOW_ANY : constants.O_NOFOLLOW), mode)
    } catch (error) {
      if (errnoOf(error) === 'ELOOP') throw linkRefusal(rel)
      throw error
    }
  }

  async #directory(parts: readonly string[]): Promise<TreeIdentity> {
    const handle = await this.#open(parts, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isDirectory()) throw coded(`"${parts.join('/')}" is not a folder.`, 'ENOTDIR')
      return identityOf(info)
    } finally {
      await handle.close()
    }
  }

  async #syncDirectory(parts: readonly string[]): Promise<void> {
    const handle = await this.#open(parts, constants.O_RDONLY | constants.O_DIRECTORY)
    try { await handle.sync() } finally { await handle.close() }
  }

  /** Whether a name exists at all, looked at without following it; its parent must already be checked. */
  async #exists(parts: readonly string[]): Promise<boolean> {
    try {
      await lstat(join(this.root, ...parts))
      return true
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return false
      throw error
    }
  }

  async #readText(parts: readonly string[], limit: number): Promise<{ readonly text: string; readonly mode: number } | null> {
    const rel = parts.join('/')
    let handle
    try {
      handle = await this.#open(parts, constants.O_RDONLY | constants.O_NONBLOCK)
    } catch (error) {
      if (NOTHING_HERE.has(errnoOf(error))) return null
      throw error
    }
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isFile() || info.nlink !== 1n) throw coded(`"${rel}" must be a regular file with no other links, so it was not read.`, 'HD_TREE_NOT_FILE')
      if (info.size > BigInt(limit)) throw coded(`"${rel}" is larger than ${Math.floor(limit / 1024)} KiB, so it was not read.`, 'HD_TREE_TOO_BIG')
      const bytes = await readBounded(handle, limit)
      if (bytes.length > limit) throw coded(`"${rel}" is larger than ${Math.floor(limit / 1024)} KiB, so it was not read.`, 'HD_TREE_TOO_BIG')
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
        throw coded(`"${rel}" is not UTF-8 text, so it was not read.`, 'HD_TREE_NOT_TEXT')
      }
      return { text, mode: Number(info.mode) & 0o777 }
    } finally {
      await handle.close()
    }
  }

  /** Creates a file exclusively, writes it through its descriptor and syncs it before returning. */
  async #writeNew(parts: readonly string[], text: string, mode: number): Promise<void> {
    const handle = await this.#open(parts, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode)
    try {
      await handle.chmod(mode)
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /** A folder's entries, at most `limit` of them; null when the folder is not there. */
  async list(rel: string, limit: number): Promise<{ readonly entries: readonly TreeEntry[]; readonly exceeded: boolean } | null> {
    const parts = partsOf(rel, true)
    await this.#checkRoot()
    let before: TreeIdentity
    try {
      before = await this.#directory(parts)
    } catch (error) {
      if (NOTHING_HERE.has(errnoOf(error))) return null
      throw error
    }
    // `opendir` takes a path, not a descriptor: the descriptor open above is what refused a link in it.
    const path = join(this.root, ...parts)
    const directory = await opendir(path)
    const entries: TreeEntry[] = []
    try {
      while (entries.length <= limit) {
        const entry = await directory.read()
        if (entry === null) break
        const kind: TreeEntryKind = entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other'
        entries.push({ name: entry.name, kind })
      }
    } finally {
      await directory.close().catch((error: unknown) => {
        if (errnoOf(error) !== 'ERR_DIR_CLOSED') throw error
      })
    }
    const after = await lstat(path, { bigint: true })
    if (!sameIdentity(before, identityOf(after))) throw rootChanged()
    return { entries: entries.slice(0, limit), exceeded: entries.length > limit }
  }

  /**
   * The real absolute path of a folder under the root: every component
   * looked at without following a link, the folder itself included, exactly
   * as a read does. Refuses `rel` outside the root, and a component that is
   * a link or is not there. A flow's own `check.cwd` is exactly the kind of
   * untrusted, repository-authored path this exists for.
   */
  async resolveDir(rel: string): Promise<string> {
    const parts = partsOf(rel, true)
    await this.#checkRoot()
    await this.#directory(parts)
    return join(this.root, ...parts)
  }

  /** A regular, singly linked UTF-8 file of at most `limit` bytes; null when it is not there. */
  async read(rel: string, limit: number): Promise<string | null> {
    const parts = partsOf(rel)
    await this.#checkRoot()
    return (await this.#readText(parts, limit))?.text ?? null
  }

  /** Makes each missing folder of `rel`, looking at its parent through the no-follow open first. */
  async ensureDir(rel: string): Promise<void> {
    this.#mayWrite()
    const parts = partsOf(rel)
    await this.#checkRoot()
    for (let length = 1; length <= parts.length; length++) {
      const step = parts.slice(0, length)
      try {
        await this.#directory(step)
        continue
      } catch (error) {
        if (errnoOf(error) === 'ENOTDIR') throw coded(`"${step.join('/')}" is not a folder, so nothing was written there.`, 'ENOTDIR')
        if (errnoOf(error) !== 'ENOENT') throw error
      }
      await this.#directory(step.slice(0, -1))
      try {
        await mkdir(join(this.root, ...step))
      } catch (error) {
        if (errnoOf(error) !== 'EEXIST') throw error
      }
      await this.#directory(step)
      await this.#syncDirectory(step.slice(0, -1))
    }
  }

  /**
   * Creates the folder `rel` holding `files`, or refuses with `EEXIST` when
   * anything is at that name — an empty folder included. The folder is built
   * under a `tempPrefix` sibling, synced, and renamed into place, so a crash
   * leaves either nothing at `rel` or the whole folder.
   */
  async createFolder(rel: string, files: readonly (readonly [string, string])[], tempPrefix: string): Promise<void> {
    this.#mayWrite()
    const parts = partsOf(rel)
    for (const [name] of files) partsOf(name)
    if (files.some(([name]) => name.includes('/'))) throw coded('A created folder holds files directly.', 'HD_TREE_PATH')
    const parent = parts.slice(0, -1)
    await this.#checkRoot()
    await this.#directory(parent)
    const exists = (): Error => coded(`"${rel}" already exists, so nothing was written there.`, 'EEXIST')
    const temporary = [...parent, `${tempPrefix}${randomUUID()}`]
    await mkdir(join(this.root, ...temporary))
    const made: string[] = []
    let moved = false
    try {
      await this.#directory(temporary)
      for (const [name, text] of files) {
        await this.#writeNew([...temporary, name], text, 0o666 & ~process.umask())
        made.push(name)
      }
      await this.#syncDirectory(temporary)
      // A rename onto an empty folder would replace it silently: anything at the name refuses.
      if (await this.#exists(parts)) throw exists()
      await rename(join(this.root, ...temporary), join(this.root, ...parts))
      moved = true
      await this.#syncDirectory(parent)
    } finally {
      if (!moved) {
        // Only what this call made, one name at a time: never a recursive removal.
        for (const name of made) await unlink(join(this.root, ...temporary, name)).catch(() => {})
        await rmdir(join(this.root, ...temporary)).catch(() => {})
      }
    }
  }

  /**
   * Replaces `rel` with `after` only while it still holds `before`: a synced
   * sibling is written first, the target is read again, and only then renamed
   * over. `unchanged` when it already holds `after`; `changed` — with nothing
   * written — when it holds anything else.
   */
  async replace(rel: string, before: string, after: string): Promise<ReplaceOutcome> {
    this.#mayWrite()
    const parts = partsOf(rel)
    const parent = parts.slice(0, -1)
    await this.#checkRoot()
    await this.#directory(parent)
    const limit = Math.max(Buffer.byteLength(before), Buffer.byteLength(after))
    const temporary = [...parent, `.${parts.at(-1)!}.${randomUUID()}.tmp`]
    const handle = await this.#open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    let moved = false
    try {
      try {
        await handle.writeFile(after, 'utf8')
        await handle.sync()
        // The one look at the target, as close to the rename as it can be:
        // a person's edit since the preview is kept, never overwritten.
        const current = await this.#readText(parts, limit).catch((error: unknown) => {
          if (errnoOf(error) === 'HD_TREE_TOO_BIG' || errnoOf(error) === 'HD_TREE_NOT_TEXT') return null
          throw error
        })
        if (current?.text === after) return 'unchanged'
        if (current?.text !== before) return 'changed'
        await handle.chmod(current.mode)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(join(this.root, ...temporary), join(this.root, ...parts))
      moved = true
      await this.#syncDirectory(parent)
      return 'replaced'
    } finally {
      if (!moved) await unlink(join(this.root, ...temporary)).catch(() => {})
    }
  }

  /** Creates one file exclusively: refuses `EEXIST` when anything is already at `rel`, an existing folder included. Never overwrites. */
  async createFile(rel: string, text: string, mode = 0o644): Promise<void> {
    this.#mayWrite()
    const parts = partsOf(rel)
    const parent = parts.slice(0, -1)
    await this.#checkRoot()
    await this.#directory(parent)
    await this.#writeNew(parts, text, mode)
    await this.#syncDirectory(parent)
  }

  /**
   * Creates one file whole, never over anything: a synced sibling is written
   * first, then given the name with `link`, which the system refuses with
   * `EEXIST` when anything is already there — a file, a folder, a link, one
   * that appeared a moment ago included. There is no look-then-rename gap for
   * another writer to land in. The sibling's own name is removed after, and
   * the folder synced. A crash leaves nothing at `rel` or the whole file,
   * never a torn one. Made under the process umask, as `createFolder`'s files
   * are, unless a mode is named.
   */
  async createAtomic(rel: string, text: string, mode = 0o666 & ~process.umask()): Promise<void> {
    this.#mayWrite()
    const parts = partsOf(rel)
    const parent = parts.slice(0, -1)
    await this.#checkRoot()
    await this.#directory(parent)
    const exists = (): Error => coded(`"${rel}" already exists, so nothing was written there.`, 'EEXIST')
    // A cheap early refusal only: the link below is what actually refuses.
    if (await this.#exists(parts)) throw exists()
    const temporary = [...parent, `.${parts.at(-1)!}.${randomUUID()}.tmp`]
    await this.#writeNew(temporary, text, mode)
    try {
      try {
        await link(join(this.root, ...temporary), join(this.root, ...parts))
      } catch (error) {
        if (errnoOf(error) === 'EEXIST') throw exists()
        throw error
      }
    } finally {
      await unlink(join(this.root, ...temporary)).catch(() => {})
    }
    await this.#syncDirectory(parent)
  }

  /** Writes host-owned state whole: a synced sibling renamed over `rel`, so a reader never sees a torn file. */
  async put(rel: string, text: string, mode = 0o600): Promise<void> {
    this.#mayWrite()
    const parts = partsOf(rel)
    const parent = parts.slice(0, -1)
    await this.#checkRoot()
    await this.#directory(parent)
    const temporary = [...parent, `.${parts.at(-1)!}.${randomUUID()}.tmp`]
    await this.#writeNew(temporary, text, mode)
    let moved = false
    try {
      await rename(join(this.root, ...temporary), join(this.root, ...parts))
      moved = true
      await this.#syncDirectory(parent)
    } finally {
      if (!moved) await unlink(join(this.root, ...temporary)).catch(() => {})
    }
  }
}
