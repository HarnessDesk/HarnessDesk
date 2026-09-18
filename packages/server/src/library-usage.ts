import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { detectSkillActivations } from '@harnessdesk/agent-inventory'
import type { LibraryUsage, LibraryUsageEntry } from '@harnessdesk/protocol'

import { errnoOf, NOTHING_HERE, NOTHING_YET } from './errno.js'

/**
 * How often each skill actually fired, counted from the transcripts the desk
 * stores.
 *
 * The library's other half (`library/read`) says what an agent *could* load;
 * this says what it *did*. An activation is a `SKILL.md` load visible in a
 * stored item — a `command` that cats it, a tool call that reads it, a
 * slash-command echo that links it. The detector lives in the scanner package
 * (`detectSkillActivations`); what lives here is only the part that cannot
 * leave the desk: knowing where this desk keeps its conversations.
 *
 * **Counted, never inferred.** A conversation held outside HarnessDesk leaves
 * no transcript here and therefore no count, so every surface that shows
 * these numbers says "in a stored conversation" rather than pretending to
 * global truth.
 *
 * **Incremental by construction.** The store on the machine this was built
 * against is 184MB; walking it on every read would make the page unusable.
 * So each transcript's extraction is cached against its `(mtimeMs, size)`,
 * and a read re-parses only what changed. The cache holds per-file findings,
 * not the aggregate — an aggregate cannot be decremented when one file
 * changes under it.
 */

interface FileFinding {
  readonly mtimeMs: number
  readonly size: number
  /** Skill name → activations in this one conversation, with the latest time. */
  readonly skills: Readonly<Record<string, { readonly n: number; readonly lastAt: number }>>
}

interface Cache {
  readonly version: 1
  readonly files: Record<string, FileFinding>
}

/** One transcript, walked. Exported through `internals` for the tests. */
const extract = (raw: string): FileFinding['skills'] => {
  let stored: {
    savedAt?: number
    turns?: readonly { startedAt?: number; completedAt?: number; items?: readonly unknown[] }[]
  }
  try {
    stored = JSON.parse(raw) as typeof stored
  } catch {
    return {}
  }
  const out: Record<string, { n: number; lastAt: number }> = {}
  for (const turn of stored.turns ?? []) {
    for (const item of turn.items ?? []) {
      // The item's own clock when it has one; the turn's, then the file's,
      // when it does not. A wrong-but-close time beats a missing one here —
      // these order a "last fired" line, they do not bill anyone. (Turns
      // carry startedAt/completedAt — an `at` field was a guess a stored
      // transcript disproved.)
      const record = item as { startedAt?: number; completedAt?: number }
      const at =
        record.completedAt ?? record.startedAt ?? turn.completedAt ?? turn.startedAt ?? stored.savedAt ?? 0
      for (const name of detectSkillActivations(JSON.stringify(item))) {
        const entry = out[name] ?? { n: 0, lastAt: 0 }
        out[name] = { n: entry.n + 1, lastAt: Math.max(entry.lastAt, at) }
      }
    }
  }
  return out
}

export interface LibraryUsageOptions {
  /** Where a folder the read had to pass over is named. */
  readonly log?: (message: string, details?: Record<string, unknown>) => void
}

export class LibraryUsageReader {
  readonly #transcripts: string
  readonly #cachePath: string
  readonly #log: NonNullable<LibraryUsageOptions['log']>
  #cache: Cache | null = null

  constructor(transcriptsDir: string, cachePath: string, options: LibraryUsageOptions = {}) {
    this.#transcripts = transcriptsDir
    this.#cachePath = cachePath
    this.#log = options.log ?? (() => {})
  }

  async read(): Promise<LibraryUsage> {
    const cache = await this.#load()
    const seen = new Set<string>()
    let dirty = false

    let dirs: readonly string[] = []
    try {
      dirs = await readdir(this.#transcripts)
    } catch (error) {
      // No transcripts yet: a fresh desk. Zero conversations is an answer.
      // A store that will not open is not, and is raised before the prune
      // below: read as empty, it answered "no skill has ever fired" and
      // emptied the cache on the way, so the next read re-parsed everything.
      if (!NOTHING_YET.has(errnoOf(error))) throw error
    }
    for (const dir of dirs) {
      let names: readonly string[] = []
      try {
        names = await readdir(join(this.#transcripts, dir))
      } catch (error) {
        if (!NOTHING_HERE.has(errnoOf(error))) {
          /* Passed over, and not forgotten. What was counted in it is still
             true of conversations still on disk, so its findings stay — seen,
             neither pruned nor left out of the answer — and the folder is
             named. A stray file here (`.DS_Store`) or a folder removed
             mid-walk is nothing, and its findings go. */
          for (const key of Object.keys(cache.files)) {
            if (key.startsWith(`${dir}/`)) seen.add(key)
          }
          this.#log('a folder of stored conversations could not be read, so its skills are counted as they were', {
            folder: join(this.#transcripts, dir),
            error: error instanceof Error ? error.message : String(error),
          })
        }
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const key = `${dir}/${name}`
        const path = join(this.#transcripts, dir, name)
        let mtimeMs: number
        let size: number
        try {
          const info = await stat(path)
          mtimeMs = info.mtimeMs
          size = info.size
        } catch {
          continue
        }
        seen.add(key)
        const kept = cache.files[key]
        if (kept && kept.mtimeMs === mtimeMs && kept.size === size) continue
        let raw: string
        try {
          raw = await readFile(path, 'utf8')
        } catch {
          continue
        }
        cache.files[key] = { mtimeMs, size, skills: extract(raw) }
        dirty = true
      }
    }
    for (const key of Object.keys(cache.files)) {
      if (!seen.has(key)) {
        delete cache.files[key]
        dirty = true
      }
    }
    if (dirty) await this.#save(cache)

    // The cache key's directory is the runtime id the conversation was
    // stored under — a retired registration keeps its old id, so a split by
    // these keys can sum to less than the totals against today's columns.
    // The protocol type says a reader must show that remainder; this just
    // keeps the keys honest.
    const skills: Record<
      string,
      {
        sessions: number
        activations: number
        lastAt: number
        byRuntime: Record<string, { sessions: number; activations: number }>
      }
    > = {}
    for (const [key, finding] of Object.entries(cache.files)) {
      const runtime = key.slice(0, key.indexOf('/'))
      for (const [name, hit] of Object.entries(finding.skills)) {
        const kept = skills[name] ?? { sessions: 0, activations: 0, lastAt: 0, byRuntime: {} }
        const bucket = kept.byRuntime[runtime] ?? { sessions: 0, activations: 0 }
        kept.byRuntime[runtime] = { sessions: bucket.sessions + 1, activations: bucket.activations + hit.n }
        kept.sessions += 1
        kept.activations += hit.n
        kept.lastAt = Math.max(kept.lastAt, hit.lastAt)
        skills[name] = kept
      }
    }
    return {
      generatedAt: Date.now(),
      sessionsScanned: seen.size,
      skills: skills as Readonly<Record<string, LibraryUsageEntry>>,
    }
  }

  async #load(): Promise<Cache> {
    if (this.#cache) return this.#cache
    try {
      const parsed = JSON.parse(await readFile(this.#cachePath, 'utf8')) as Cache
      if (parsed.version === 1 && parsed.files && typeof parsed.files === 'object') {
        this.#cache = { version: 1, files: parsed.files }
        return this.#cache
      }
    } catch {
      // Absent or unreadable: rebuilt from the transcripts, which stay the
      // source of truth. The cache is only ever a saved re-reading of them.
    }
    this.#cache = { version: 1, files: {} }
    return this.#cache
  }

  async #save(cache: Cache): Promise<void> {
    this.#cache = cache
    try {
      await mkdir(dirname(this.#cachePath), { recursive: true })
      const tmp = `${this.#cachePath}.tmp`
      await writeFile(tmp, JSON.stringify(cache))
      await rename(tmp, this.#cachePath)
    } catch {
      // A cache that cannot be written costs the next read a re-parse and
      // nothing else.
    }
  }
}

/** Exported for the tests, which drive the extraction directly. */
export const internals = { extract }
