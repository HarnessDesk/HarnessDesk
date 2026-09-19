import { execFile } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { plainCipher, type CredentialCipher } from '../credentials.js'
import { errnoOf, NOTHING_YET } from '../errno.js'

/**
 * The commands a person has approved on this machine.
 *
 * **Security-critical.** A command a repository names runs only after a
 * person has seen it here, verbatim, and approved it. What is kept is the
 * *current* answer only — one per project and check name — and it counts only
 * while three things still hold:
 *
 * - **The same repository.** A project is its path *and* its incarnation: the
 *   identity on disk of the repository's own git directory. A different
 *   repository cloned into the same path is a different project, and nothing
 *   approved for the old one carries over.
 * - **The same file.** An approval is bound to the checks file's generation —
 *   the committed blob the person was shown (`checks-file.ts`). When the file
 *   is read and has changed in any way — a check added, removed, renamed or
 *   edited, even a comment — every approval for that project is dropped, so an
 *   old answer can never come back to life: a command that went A → B → A asks
 *   three times, and a check removed and added again asks again.
 * - **This machine.** Every entry carries an HMAC under a key only this machine
 *   can read — sealed with the desk's credential cipher, which the desktop app
 *   backs with the OS keychain — so a file copied from elsewhere, or edited by
 *   hand, approves nothing.
 *
 * Its own file, `commands-seen.json` beside `state.json`, with its key in
 * `commands-seen.key`. Never in `state.json`'s preferences, which
 * `app/state/set` patches wholesale and every backup carries and restores; no
 * backup carries either file, and no wire verb writes them but the one that
 * asks. It fails closed: a file that is not there, not JSON, or not verifiable
 * approves nothing; a file a newer build wrote is never written over.
 */

export const SEEN_FILE = 'commands-seen.json'

/** Bumped only when an older build could no longer read the file truthfully. */
const FORMAT = 1

/** The most entries kept. The oldest go first; one that goes asks again, which is the safe way to forget. */
export const SEEN_LIMIT = 1_000

/** Where a question was asked: which repository, and which generation of its checks file. */
export interface ApprovalScope {
  /** The top of the project's main checkout. */
  readonly project: string
  /** Its repository's identity on disk (`incarnationOf`). */
  readonly incarnation: string
  /** The checks file's committed blob id: the generation the person was shown. */
  readonly digest: string
}

interface Approval {
  readonly project: string
  readonly incarnation: string
  readonly name: string
  readonly run: string
  readonly digest: string
  readonly at: number
  readonly mac: string
}

/** What was approved under a name before its file changed: never an approval, only what a question says ran before. */
interface Before {
  readonly project: string
  readonly incarnation: string
  readonly name: string
  readonly run: string
  readonly mac: string
}

interface SeenFile {
  readonly approvals: readonly Approval[]
  readonly before: readonly Before[]
}

const isString = (value: unknown): value is string => typeof value === 'string'

const isApproval = (value: unknown): value is Approval => {
  const one = value as Partial<Approval> | null
  return (
    typeof one === 'object' &&
    one !== null &&
    [one.project, one.incarnation, one.name, one.run, one.digest, one.mac].every(isString) &&
    Number.isFinite(one.at)
  )
}

const isBefore = (value: unknown): value is Before => {
  const one = value as Partial<Before> | null
  return typeof one === 'object' && one !== null && [one.project, one.incarnation, one.name, one.run, one.mac].every(isString)
}

const run = promisify(execFile)

/**
 * A project's incarnation: its repository's git directory — or, outside a
 * repository, the folder itself — named by where it is and what it is on disk
 * (device, inode, and when it was made). A repository deleted and cloned again
 * at the same path is a new directory, so it is a new incarnation.
 */
export const incarnationOf = async (project: string): Promise<string> => {
  let target = project
  try {
    const { stdout } = await run('git', ['-C', project, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      timeout: 20_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    if (stdout.trim() !== '') target = stdout.trim()
  } catch {
    // Not a repository: the folder is its own identity.
  }
  const real = await realpath(target)
  const info = await stat(real)
  return createHash('sha256')
    .update(JSON.stringify([real, info.dev, info.ino, info.birthtimeMs]))
    .digest('hex')
    .slice(0, 32)
}

export class CommandsSeen {
  readonly #file: string
  readonly #keyFile: string
  readonly #cipher: CredentialCipher
  readonly #now: () => number
  #writes: Promise<void> = Promise.resolve()

  constructor(file: string, options: { readonly cipher?: CredentialCipher; readonly now?: () => number } = {}) {
    this.#file = file
    this.#keyFile = file.replace(/\.json$/, '.key')
    this.#cipher = options.cipher ?? plainCipher
    this.#now = options.now ?? Date.now
  }

  /** Whether this check, exactly as it is in this generation of this repository's file, is approved on this machine. */
  async approved(scope: ApprovalScope, check: { readonly name: string; readonly run: string }): Promise<boolean> {
    await this.#writes
    const { seen, key } = await this.#read()
    return seen.approvals.some(
      (one) =>
        one.project === scope.project &&
        one.incarnation === scope.incarnation &&
        one.digest === scope.digest &&
        one.name === check.name &&
        one.run === check.run &&
        this.#verify(key, one),
    )
  }

  /** The command approved under this name before it changed — what a question says ran before — or null. */
  async previous(scope: ApprovalScope, name: string, run: string): Promise<string | null> {
    await this.#writes
    const { seen, key } = await this.#read()
    const same = (one: { project: string; incarnation: string; name: string }): boolean =>
      one.project === scope.project && one.incarnation === scope.incarnation && one.name === name
    const was =
      seen.approvals.find((one) => same(one) && this.#verify(key, one))?.run ??
      seen.before.find((one) => same(one) && this.#verify(key, one))?.run ??
      null
    return was === run ? null : was
  }

  /**
   * Drops every approval for this project that no longer holds — another
   * repository at its path, another generation of its checks file, a name the
   * file no longer has — keeping each dropped command only as what ran before.
   * Called whenever the file is read, so a change is noticed before anything
   * asks whether a command is approved. Writes only when something changed.
   */
  reconcile(scope: ApprovalScope, names: readonly string[]): Promise<void> {
    return this.#change((seen, key) => {
      const current = new Set(names)
      const approvals: Approval[] = []
      const before = seen.before.filter((one) => one.project !== scope.project || one.incarnation === scope.incarnation)
      let changed = before.length !== seen.before.length
      for (const one of seen.approvals) {
        if (one.project !== scope.project) {
          approvals.push(one)
          continue
        }
        if (one.incarnation !== scope.incarnation) {
          changed = true
          continue
        }
        if (one.digest === scope.digest && current.has(one.name) && this.#verify(key, one)) {
          approvals.push(one)
          continue
        }
        changed = true
        if (this.#verify(key, one)) before.push(this.#seal(key, { project: one.project, incarnation: one.incarnation, name: one.name, run: one.run }))
      }
      return changed ? { approvals, before: this.#keepLast(before) } : null
    }, false)
  }

  /** Records the person's answer, verbatim, now: the only approval this project and name then have. */
  approve(scope: ApprovalScope, check: { readonly name: string; readonly run: string }): Promise<void> {
    return this.#change((seen, key) => {
      const same = (one: { project: string; name: string }): boolean => one.project === scope.project && one.name === check.name
      const replaced = seen.approvals.find((one) => same(one) && this.#verify(key, one))
      const approval = this.#seal(key, {
        project: scope.project,
        incarnation: scope.incarnation,
        name: check.name,
        run: check.run,
        digest: scope.digest,
        at: this.#now(),
      })
      const before = seen.before.filter((one) => !same(one))
      if (replaced && replaced.run !== check.run) {
        before.push(this.#seal(key, { project: replaced.project, incarnation: replaced.incarnation, name: replaced.name, run: replaced.run }))
      }
      return {
        approvals: [...seen.approvals.filter((one) => !same(one)), approval].slice(-SEEN_LIMIT),
        before: this.#keepLast(before),
      }
    }, true)
  }

  /** Every change goes through here, one at a time, and writes aside and renames so a crash leaves one whole file. */
  #change(next: (seen: SeenFile, key: Buffer) => SeenFile | null, mintKey: boolean): Promise<void> {
    const write = this.#writes.then(async () => {
      const read = await this.#read()
      if (read.refused !== null) {
        if (!mintKey) return
        throw new Error(`${read.refused}, so the command you saw could not be recorded, and it was not run.`)
      }
      const key = read.key ?? (mintKey ? await this.#mintKey() : null)
      if (key === null) return
      const changed = next(read.key ? read.seen : { approvals: [], before: [] }, key)
      if (changed === null) return
      await mkdir(dirname(this.#file), { recursive: true })
      const temp = `${this.#file}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify({ version: FORMAT, ...changed }, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.#file)
    })
    this.#writes = write.catch(() => {})
    return write
  }

  /** What is recorded, the key that vouches for it, and why nothing may be written when nothing may. */
  async #read(): Promise<{ readonly seen: SeenFile; readonly key: Buffer | null; readonly refused: string | null }> {
    const empty: SeenFile = { approvals: [], before: [] }
    const key = await this.#readKey()
    let raw: string
    try {
      raw = await readFile(this.#file, 'utf8')
    } catch (error) {
      if (NOTHING_YET.has(errnoOf(error))) return { seen: empty, key, refused: null }
      return { seen: empty, key, refused: `${this.#file} could not be read: ${error instanceof Error ? error.message : String(error)}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { seen: empty, key, refused: null }
    }
    const file = parsed as { version?: unknown; approvals?: unknown; before?: unknown } | null
    if (typeof file !== 'object' || file === null) return { seen: empty, key, refused: null }
    if (typeof file.version === 'number' && file.version > FORMAT) {
      return {
        seen: empty,
        key,
        refused: `${this.#file} was written by a newer HarnessDesk (format ${file.version}; this build reads ${FORMAT})`,
      }
    }
    return {
      seen: {
        approvals: Array.isArray(file.approvals) ? file.approvals.filter(isApproval) : [],
        before: Array.isArray(file.before) ? file.before.filter(isBefore) : [],
      },
      key,
      refused: null,
    }
  }

  /** This machine's key, unsealed — or null when there is none yet, or it was sealed somewhere else. */
  async #readKey(): Promise<Buffer | null> {
    try {
      const hex = this.#cipher.decrypt(await readFile(this.#keyFile))
      return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null
    } catch {
      return null
    }
  }

  /** A new key, sealed and kept — replacing one this machine cannot unseal, whose entries could never verify again. */
  async #mintKey(): Promise<Buffer> {
    const key = randomBytes(32)
    await mkdir(dirname(this.#keyFile), { recursive: true })
    const temp = `${this.#keyFile}.${process.pid}.tmp`
    await writeFile(temp, this.#cipher.encrypt(key.toString('hex')), { mode: 0o600 })
    await rename(temp, this.#keyFile)
    return key
  }

  #mac(key: Buffer, fields: readonly unknown[]): string {
    return createHmac('sha256', key).update(JSON.stringify(fields)).digest('hex')
  }

  #seal<T extends { readonly project: string; readonly incarnation: string; readonly name: string; readonly run: string }>(
    key: Buffer,
    entry: T,
  ): T & { readonly mac: string } {
    const { project, incarnation, name, run } = entry
    const bound = entry as unknown as Partial<Pick<Approval, 'digest' | 'at'>>
    const extra = bound.digest === undefined ? [] : [bound.digest, bound.at]
    return { ...entry, mac: this.#mac(key, [project, incarnation, name, run, ...extra]) }
  }

  #verify(key: Buffer | null, entry: Approval | Before): boolean {
    if (key === null) return false
    const extra = 'digest' in entry ? [entry.digest, entry.at] : []
    const expected = Buffer.from(this.#mac(key, [entry.project, entry.incarnation, entry.name, entry.run, ...extra]), 'hex')
    const given = Buffer.from(entry.mac, 'hex')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  #keepLast(before: readonly Before[]): Before[] {
    return before.slice(-SEEN_LIMIT)
  }
}
