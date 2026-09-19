import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { errnoOf, NOTHING_YET } from '../errno.js'
import { LINE_LIMIT, lineOf, lineText, type StoreFile, type StoredLine } from './records.js'

export type { StoreFile } from './records.js'

/**
 * The evidence store: what the desk observed, and every Seat it kept.
 *
 * One folder per project under `~/.harnessdesk/evidence/`, named for the
 * project and a hash of its path — never inside the project, which is somebody
 * else's repository. Two files in each, both append-only NDJSON: `seats.ndjson`
 * holds every Seat's opening and closing, `evidence.ndjson` every fact. They
 * are apart so that a launch, which needs every Seat, never reads a year of
 * facts to find them.
 *
 * Nothing here updates or deletes a line, and there is no method that could.
 *
 * **What an append promises.** Appends through one store are queued, one at a
 * time. Each line is written by one `write` of at most `LINE_LIMIT` bytes to a
 * file opened for appending, so two writers — a second store on the same
 * folder, another process — can put their lines in either order but never
 * inside each other's. A line a crash cut short is ended before the next one is
 * written, so it cannot swallow the line after it. And an append resolves only
 * after the file is synced: a Seat the desk answered with is on the disk, not in
 * a cache. A batch is written line by line, so a crash part-way leaves the
 * lines before it whole and nothing after.
 *
 * **One writer.** The host holds the only store on its state directory — the
 * desk runs one host per home — and everything that writes evidence goes
 * through it, so a read inside `merge` sees every line written before it. A
 * second store on the same folder (a test's reader, a restore's check) is safe
 * to write through, by the promise above, but only one queue orders its reads
 * against its own writes.
 *
 * A write that fails rejects its caller, and is kept to be reported again by
 * the next `flush()`: the desk's quit says what was lost rather than swallowing
 * it. A reader skips what it cannot read, and counts it (`records.ts`).
 */

/** What a read found: the lines this build can read, and how many it could not. */
export interface StoreRead {
  readonly lines: readonly StoredLine[]
  readonly skipped: number
}

/** What `merge` did with each line it was given. */
export interface MergeCount {
  readonly added: number
  readonly duplicate: number
  readonly refused: number
}

/** What a merge knew had happened when a later line in its append failed. */
export interface MergeFailureCount extends MergeCount {
  readonly failed: number
}

/** A merge can leave a whole appended prefix; its caller needs that count rather than an all-or-nothing lie. */
export class EvidenceMergeError extends Error {
  override readonly cause: unknown
  readonly count: MergeFailureCount

  constructor(cause: unknown, count: MergeFailureCount) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'EvidenceMergeError'
    this.cause = cause
    this.count = count
  }
}

/** How much of one append completed before its first write-side failure. */
class EvidenceWriteError extends Error {
  override readonly cause: unknown
  readonly written: number

  constructor(cause: unknown, written: number) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'EvidenceWriteError'
    this.cause = cause
    this.written = written
  }
}

/** `merge`'s question about each incoming line: add it, pass it over as already here, or refuse it. */
export type Admit = (
  line: StoredLine,
  here: readonly StoredLine[],
  added: readonly StoredLine[],
) => 'add' | 'duplicate' | 'refused'

const FILE_OF: Readonly<Record<StoreFile, string>> = {
  seats: 'seats.ndjson',
  evidence: 'evidence.ndjson',
}

/** Where a folder says which project it belongs to: the hash in its name cannot be read backwards. */
const PROJECT_FILE = 'project.json'

export class EvidenceStore {
  readonly #dir: string
  readonly #log: (message: string, details: Readonly<Record<string, unknown>>) => void
  #queue: Promise<void> = Promise.resolve()
  /** The first write that failed since the last `flush()`. */
  #failure: unknown = null

  constructor(dir: string, log: (message: string, details: Readonly<Record<string, unknown>>) => void = () => {}) {
    this.#dir = dir
    this.#log = log
  }

  /** The folder a project's records live in: its name and the first ten hex characters of its path's hash. */
  folderOf(project: string): string {
    const hash = createHash('sha256').update(project).digest('hex').slice(0, 10)
    return join(this.#dir, `${basename(project) || 'root'}-${hash}`)
  }

  /** Appends lines to one of a project's two files, after every write queued before them. Resolves once they are synced. */
  append(project: string, file: StoreFile, lines: readonly StoredLine[]): Promise<void> {
    return this.#enqueue(() => this.#write(project, file, lines))
  }

  /**
   * Reads a file and appends to it as one queued step, so what `admit` was
   * shown is still what is there when the admitted lines go down. `admit` sees
   * every line already in the file and the ones this call admitted before, and
   * says of each incoming line whether it is added, already here, or refused.
   */
  merge(project: string, file: StoreFile, incoming: readonly StoredLine[], admit: Admit): Promise<MergeCount> {
    return this.#enqueue(async () => {
      const { lines: here } = await this.#readNow(project, file)
      const added: StoredLine[] = []
      let duplicate = 0
      let refused = 0
      for (const line of incoming) {
        const verdict = admit(line, here, added)
        if (verdict === 'add') added.push(line)
        else if (verdict === 'duplicate') duplicate += 1
        else refused += 1
      }
      try {
        await this.#write(project, file, added)
        return { added: added.length, duplicate, refused }
      } catch (error) {
        const written = error instanceof EvidenceWriteError ? Math.min(error.written, added.length) : 0
        throw new EvidenceMergeError(error instanceof EvidenceWriteError ? error.cause : error, {
          added: written,
          duplicate,
          refused,
          failed: added.length - written,
        })
      }
    })
  }

  /** Every line of one of a project's files this build can read there, in the order written. */
  async read(project: string, file: StoreFile): Promise<StoreRead> {
    await this.#queue
    return this.#readNow(project, file)
  }

  /** Every project this store holds records for, as each folder names it. */
  async projects(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.#dir)
    } catch (error) {
      if (NOTHING_YET.has(errnoOf(error))) return []
      throw error
    }
    const out: string[] = []
    for (const name of names.sort()) {
      try {
        const said = JSON.parse(await readFile(join(this.#dir, name, PROJECT_FILE), 'utf8')) as { root?: unknown }
        if (typeof said.root === 'string' && said.root !== '' && this.folderOf(said.root) === join(this.#dir, name)) {
          out.push(said.root)
        }
      } catch {
        // A folder that does not say which project it is, or says one whose hash is not its name, is not read.
      }
    }
    return out
  }

  /**
   * Resolves once every write queued so far is synced — and rejects with the
   * first write that failed since the last flush, so a quit says what it lost.
   */
  async flush(): Promise<void> {
    await this.#queue
    const failure = this.#failure
    this.#failure = null
    if (failure !== null) throw failure
  }

  #enqueue<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(step)
    this.#queue = run.then(
      () => undefined,
      (error: unknown) => {
        this.#failure ??= error
      },
    )
    return run
  }

  async #write(project: string, file: StoreFile, lines: readonly StoredLine[]): Promise<void> {
    if (lines.length === 0) return
    const texts = lines.map((line) => Buffer.from(lineText(line)))
    const large = texts.find((text) => text.length > LINE_LIMIT)
    if (large) {
      throw new Error(`A record would be ${large.length} bytes and a line may be at most ${LINE_LIMIT}, so none of these was written.`)
    }
    let written = 0
    try {
      const folder = this.folderOf(project)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      await writeFile(join(folder, PROJECT_FILE), `${JSON.stringify({ root: project })}\n`, {
        flag: 'wx',
        mode: 0o600,
      }).catch((error: unknown) => {
        if (errnoOf(error) !== 'EEXIST') throw error
      })
      const handle = await open(join(folder, FILE_OF[file]), 'a+', 0o600)
      try {
        const { size } = await handle.stat()
        if (size > 0) {
          // A line a crash cut short is ended here, so it cannot swallow the next one.
          const last = Buffer.alloc(1)
          await handle.read(last, 0, 1, size - 1)
          if (last[0] !== 0x0a) await handle.write(Buffer.from('\n'))
        }
        for (const text of texts) {
          // One write per line, on a file opened for appending: never inside another writer's line.
          const { bytesWritten } = await handle.write(text)
          if (bytesWritten !== text.length) throw new Error('A record was written short; the next write ends it.')
          written += 1
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      throw new EvidenceWriteError(error, written)
    }
  }

  async #readNow(project: string, file: StoreFile): Promise<StoreRead> {
    let raw: string
    try {
      raw = await readFile(join(this.folderOf(project), FILE_OF[file]), 'utf8')
    } catch (error) {
      if (NOTHING_YET.has(errnoOf(error))) return { lines: [], skipped: 0 }
      throw error
    }
    const lines: StoredLine[] = []
    let skipped = 0
    for (const text of raw.split('\n')) {
      if (text.trim() === '') continue
      if (Buffer.byteLength(text) > LINE_LIMIT) {
        skipped += 1
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        skipped += 1
        continue
      }
      const line = lineOf(parsed, { file, project })
      if (line) lines.push(line)
      else skipped += 1
    }
    if (skipped > 0) {
      this.#log('some evidence records could not be read and were skipped', { project, file, skipped })
    }
    return { lines, skipped }
  }
}
