import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { RuntimeId, SessionId } from '@harnessdesk/protocol'

/**
 * The names for agents that keep none.
 *
 * Codex can name a thread: `thread/setTitle` writes it, and Codex Desktop
 * agrees the next time it looks. ACP has no such method — its whole session
 * surface is `new`, `load`, `resume`, `fork`, `list`, `prompt`, `cancel` — so
 * Claude Code, Cursor and every other agent behind the bridge had nowhere to
 * put a name, and renaming one failed with "does not support naming a
 * session". The rename was offered, went through the store, and threw at the
 * bottom; three conversations on the same agent stayed three rows all called
 * after the agent, which is exactly when a name matters most.
 *
 * That is a gap in the agent, not a reason for the app to be missing a verb.
 * Naming a conversation is the most ordinary thing a person does with a list
 * of them, and it costs nothing: the transcript stays where the agent wrote
 * it, and the name is one line in one file here.
 *
 * The same exception the transcript store and the archive earned, for the same
 * reason and with the same limit: HarnessDesk holds what the agent does not,
 * and never shadows what it does. A runtime whose `nameHistory` capability is
 * true is never written down here — its own title is the authority, and two
 * names disagreeing is worse than one that is only ours.
 *
 * `<state>/names.json`:
 *
 * ```json
 * { "version": 1, "entries": [{ "runtime": "cursor", "sessionId": "x", "name": "reviewer" }] }
 * ```
 */

interface Entry {
  readonly runtime: string
  readonly sessionId: string
  readonly name: string
}

interface Stored {
  readonly version: 1
  readonly entries: readonly Entry[]
}

const FORMAT = 1

const keyOf = (runtime: string, id: string): string => `${runtime} ${id}`

export class SessionNames {
  readonly #path: string
  #entries = new Map<string, string>()
  #loaded = false

  constructor(path: string) {
    this.#path = path
  }

  /**
   * Reads the file once. A name nobody can read is a name nobody set, which
   * is a worse listing than the agent's own — never a reason to fail the
   * listing itself.
   */
  async load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const raw = JSON.parse(await readFile(this.#path, 'utf8')) as Partial<Stored>
      if (raw.version !== FORMAT || !Array.isArray(raw.entries)) return
      for (const entry of raw.entries) {
        if (typeof entry?.runtime !== 'string' || typeof entry.sessionId !== 'string') continue
        if (typeof entry.name !== 'string' || entry.name === '') continue
        this.#entries.set(keyOf(entry.runtime, entry.sessionId), entry.name)
      }
    } catch {
      // No file yet, or one written by something else. Either way there are
      // no names, and the agents' own titles stand.
    }
  }

  /** The name the user gave this conversation, or null when they gave none. */
  nameOf(runtime: RuntimeId, id: SessionId): string | null {
    return this.#entries.get(keyOf(String(runtime), String(id))) ?? null
  }

  /** Names a conversation, or — with an empty name — hands it back its own. */
  async set(runtime: RuntimeId, id: SessionId, name: string): Promise<void> {
    await this.load()
    const key = keyOf(String(runtime), String(id))
    const trimmed = name.trim()
    if (trimmed === '') this.#entries.delete(key)
    else this.#entries.set(key, trimmed)
    await this.#write()
  }

  /** Drops a name, for a conversation being deleted for good. */
  async forget(runtime: RuntimeId, id: SessionId): Promise<void> {
    await this.load()
    if (!this.#entries.delete(keyOf(String(runtime), String(id)))) return
    await this.#write()
  }

  async #write(): Promise<void> {
    const document: Stored = {
      version: FORMAT,
      entries: [...this.#entries].map(([key, name]) => {
        const gap = key.indexOf(' ')
        return { runtime: key.slice(0, gap), sessionId: key.slice(gap + 1), name }
      }),
    }
    await mkdir(dirname(this.#path), { recursive: true })
    // Written beside and moved into place: a half-written names file read at
    // the next start would lose every name at once.
    const scratch = `${this.#path}.${process.pid}.tmp`
    await writeFile(scratch, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(scratch, this.#path)
  }
}
