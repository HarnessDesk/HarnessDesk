import { homedir } from 'node:os'

import { LibraryManifest, readLibrary, type InventoryAgent } from '@harnessdesk/agent-inventory'
import type { Library, LibrarySkillOrigin, LibrarySkillUpdate } from '@harnessdesk/protocol'

import type { LibrarySources } from './library-sources.js'

const sourceKey = (origin: LibrarySkillOrigin | undefined): string => JSON.stringify(origin && [origin.url, origin.ref, origin.commit, origin.path])

/** Explicit checks live with this host, never in the manifest or the read path. */
export class LibraryUpdates {
  readonly #checks = new Map<string, LibrarySkillUpdate>()

  constructor(
    readonly libraryDir: string,
    readonly sources: Pick<LibrarySources, 'check'>,
    readonly home: string = homedir(),
  ) {}

  async check(agents: readonly InventoryAgent[], names?: readonly string[]): Promise<readonly LibrarySkillUpdate[]> {
    // The disk scan establishes which manifest copies are still installed.
    const library = await readLibrary(agents.map(({ id, brand }) => ({ id, brand })), { home: this.home })
    const manifest = await LibraryManifest.load(this.libraryDir)
    const results: LibrarySkillUpdate[] = []
    const checked = new Map<string, ReturnType<LibrarySources['check']>>()
    for (const entry of library.entries) {
      if (entry.kind !== 'skill' || (names !== undefined && !names.includes(entry.name))) continue
      for (const copy of entry.copies) {
        if (copy.hollow) continue
        const origin = manifest.find('skill', copy.path, entry.name)?.origin
        if (!origin) continue
        const key = sourceKey(origin)
        let pending = checked.get(key)
        if (!pending) { pending = this.sources.check(origin); checked.set(key, pending) }
        const result = await pending
        for (const runtime of copy.readBy) {
          const update = { name: entry.name, runtime, origin, ...result }
          this.#checks.set(JSON.stringify([copy.path, runtime]), update)
          results.push(update)
        }
      }
    }
    return results
  }

  async read(agents: readonly InventoryAgent[], params: { readonly cwd?: string }): Promise<Library> {
    const library = await readLibrary(agents, { ...params, home: this.home })
    const manifest = await LibraryManifest.load(this.libraryDir)
    let changed = false
    const entries = library.entries.map(entry => {
      if (entry.kind !== 'skill') return entry
      const copies = entry.copies.map(copy => {
        const origin = !copy.hollow && manifest.find('skill', copy.path, entry.name)?.origin
        if (!origin) return copy
        const { url, ref, commit, path, installedAt } = origin
        return { ...copy, origin: { url, ref, commit, path, ...(installedAt !== undefined ? { installedAt } : {}) } }
      })
      const update = entry.copies.flatMap(copy => copy.readBy.flatMap(runtime => {
        const checked = this.#checks.get(JSON.stringify([copy.path, runtime]))
        const origin = manifest.find('skill', copy.path, entry.name)?.origin
        return !copy.hollow && checked && sourceKey(checked.origin) === sourceKey(origin) ? [checked] : []
      }))
      if (!update.length && copies.every((copy, index) => copy === entry.copies[index])) return entry
      changed = true
      return { ...entry, copies, ...(update.length ? { update } : {}) }
    })
    return changed ? { ...library, entries } : library
  }
}
