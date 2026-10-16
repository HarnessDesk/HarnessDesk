import type { LibraryEntry, LibrarySkillOrigin, LibrarySkillUpdate } from '@harnessdesk/protocol'

/** One finding for every runtime copy, in the order a person can act on it. */
export const libraryUpdateFor = (entry: LibraryEntry): LibrarySkillUpdate | undefined => {
  for (const status of ['behind', 'gone', 'unreachable'] as const) {
    const update = entry.update?.find(one => one.status === status)
    if (update) return update
  }
  return undefined
}

export const libraryRepository = (origin: LibrarySkillOrigin): string => new URL(origin.url).pathname.replace(/^\//, '').replace(/\.git$/, '')
