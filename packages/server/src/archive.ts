import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { RuntimeId, SessionId } from '@harnessdesk/protocol'

/**
 * The archive for agents that keep none.
 *
 * Codex has a real archive: `thread/archive` moves a thread out of its own
 * list, and Codex Desktop agrees the next time it looks. ACP has no such
 * method at all — its whole session surface is `new`, `load`, `resume`,
 * `fork`, `list`, `prompt`, `cancel` — so Claude Code, Cursor and every other
 * agent behind the bridge had nowhere to put an archived conversation, and
 * archiving one failed with "keeps no session archive".
 *
 * That is a gap in the agent, not a reason for the app to be missing a verb.
 * Taking a finished conversation out of the list is the most ordinary thing a
 * person does with a list of conversations, and it loses nothing: the
 * transcript stays where the agent wrote it, and the mark is one line in one
 * file here. So the host keeps it, for exactly the runtimes that cannot.
 *
 * The same exception the transcript store earned, for the same reason and
 * with the same limit: HarnessDesk holds what the agent does not, and never
 * shadows what it does. A runtime whose `archiveHistory` capability is true
 * is never written down here — its own archive is the authority, and two
 * archives disagreeing is worse than one that is only ours.
 *
 * `<state>/archive.json`:
 *
 * ```json
 * { "version": 1, "entries": [{ "runtime": "claude-code", "sessionId": "x", "archivedAt": 0 }] }
 * ```
 */

interface Entry {
  readonly runtime: string
  readonly sessionId: string
  /** When the user archived it, for the archive screen's "Archived <when>". */
  readonly archivedAt: number
}

interface Stored {
  readonly version: 1
  readonly entries: readonly Entry[]
}

const FORMAT = 1

const keyOf = (runtime: string, id: string): string => `${runtime} ${id}`

export class SessionArchive {
  readonly #entries = new Map<string, Entry>()
  #loaded = false
  #loading: Promise<void> | null = null
  #writes: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  /**
   * Reads the file once. A missing or unreadable one is an empty archive:
   * losing the marks shows conversations that were hidden, which is a
   * nuisance, and failing to start is not.
   */
  async load(): Promise<void> {
    if (this.#loaded) return
    if (this.#loading) return this.#loading
    this.#loading = (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Stored>
        if (parsed.version !== FORMAT || !Array.isArray(parsed.entries)) return
        for (const entry of parsed.entries) {
          if (typeof entry?.runtime !== 'string' || typeof entry?.sessionId !== 'string') continue
          this.#entries.set(keyOf(entry.runtime, entry.sessionId), {
            runtime: entry.runtime,
            sessionId: entry.sessionId,
            archivedAt: typeof entry.archivedAt === 'number' ? entry.archivedAt : 0,
          })
        }
      } catch {
        // No archive yet, or one this build cannot read. Either is empty.
      } finally {
        this.#loaded = true
        this.#loading = null
      }
    })()
    return this.#loading
  }

  has(runtime: RuntimeId, id: SessionId): boolean {
    return this.#entries.has(keyOf(String(runtime), String(id)))
  }

  /** When a session was archived, or null if it is not. */
  archivedAt(runtime: RuntimeId, id: SessionId): number | null {
    return this.#entries.get(keyOf(String(runtime), String(id)))?.archivedAt ?? null
  }

  /** How many of one runtime's sessions are archived here. */
  count(runtime: RuntimeId): number {
    let total = 0
    for (const entry of this.#entries.values()) if (entry.runtime === String(runtime)) total += 1
    return total
  }

  async set(runtime: RuntimeId, id: SessionId, archived: boolean): Promise<void> {
    await this.load()
    const key = keyOf(String(runtime), String(id))
    if (archived) {
      if (this.#entries.has(key)) return
      this.#entries.set(key, {
        runtime: String(runtime),
        sessionId: String(id),
        archivedAt: Date.now(),
      })
    } else if (!this.#entries.delete(key)) {
      return
    }
    await this.#persist()
  }

  /** Drops the mark without unarchiving anything — what a delete leaves behind. */
  async forget(runtime: RuntimeId, id: SessionId): Promise<void> {
    await this.load()
    if (!this.#entries.delete(keyOf(String(runtime), String(id)))) return
    await this.#persist()
  }

  async #persist(): Promise<void> {
    const snapshot = JSON.stringify(
      { version: FORMAT, entries: [...this.#entries.values()] } satisfies Stored,
      null,
      2,
    )
    const previous = this.#writes
    const current = (async () => {
      await previous.catch(() => {})
      await mkdir(dirname(this.file), { recursive: true })
      // Write-then-rename, like every other file the host owns: a crash
      // mid-write must not leave an archive that will not parse.
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, `${snapshot}\n`)
      await rename(temp, this.file)
    })()
    this.#writes = current.catch(() => {})
    await current
  }
}
