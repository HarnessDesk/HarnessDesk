import { type Library, type LibraryEntry } from '@harnessdesk/protocol'
import type { AppStore } from '../state/store'

/** Both page states read synthetic on-disk facts, without changing the shared Library specimen. */
export const installSkillPageFixture = (store: AppStore, state: string | null) => {
  if (state !== 'healthy' && state !== 'findings') return
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method, params) => {
    const answer = await request(method, params)
    if (method !== 'library/read') return answer
    const library = answer as Library
    return { ...library, entries: library.entries.map((entry): LibraryEntry => {
      if (entry.kind !== 'skill' || entry.name !== 'code-review') return entry
      const copy = entry.copies[0]!
      return { ...entry, update: [], copies: [{ ...copy,
        origin: { url: 'https://github.com/acme-dev/skills', ref: 'main', commit: '1234567890abcdef', path: 'review/code-review' },
        readBy: state === 'healthy' ? library.runtimes : [library.runtimes[1]!],
      }], reach: library.runtimes.map((runtime, index) => state === 'findings' && index === 0
        ? { runtime, state: 'rejected', basis: 'reported', note: 'missing field `description`' }
        : { runtime, state: state === 'healthy' || index === 1 ? 'reaches' : 'absent', basis: 'scanned' }) }
    }) }
  }) as typeof store.transport.request
}
