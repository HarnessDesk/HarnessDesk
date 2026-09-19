import { describe, expect, it } from 'vitest'

import { resolveSection } from '../components/Settings'

/**
 * The route id `agents` is reused.
 *
 * It named the page of installed CLIs and their accounts; from this phase it
 * names the roster of Agents, and that page is `runtimes`. `MOVED` cannot
 * carry an id that still exists, so every door that meant the CLIs — a
 * sign-in, an "add another", ⌘, — moved to `runtimes` by hand, and this is
 * the test that nothing was left behind asking the roster for a sign-in.
 *
 * It reads the renderer's source for literal routes, because a door is a
 * string handed to one of a few verbs, and the door nobody renders in a test
 * is exactly the one that rots.
 *
 * Read through the bundler rather than `node:fs`: the renderer has no
 * filesystem, its tests included (`pnpm layering` — see the same note on
 * `lib/avatars.test.ts`), so the source text comes in as `?raw` imports via
 * `import.meta.glob`, the pattern `panels/lights.test.ts` already uses for
 * the same kind of source-text audit.
 */

const sources = import.meta.glob<string>('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/**
 * A glob key relative to this file's own directory (`app/`), turned into a
 * path relative to `src/` — `./App.tsx` → `app/App.tsx`,
 * `../components/Settings.tsx` → `components/Settings.tsx` — so an offender
 * reads the same whichever side of `app/` it lives on.
 */
const relativeToSrc = (key: string): string =>
  key.startsWith('../') ? key.slice(3) : `app/${key.slice(2)}`

/** Every way the renderer spells a route to the `agents` page. */
const DOORS: readonly RegExp[] = [
  /\b(?:setSettingsOpen|askSettings|openSettings|onOpenSettings|onSection)\(\s*'agents'/g,
  /\?\?\s*'agents'\s*\)/g,
  /\bsection\s*=\s*'agents'/g,
  /\bfallback:\s*Section\s*=\s*'agents'/g,
]

/**
 * The files allowed to open the roster, each for a reason that is about an
 * Agent rather than a runtime. Empty until the roster exists; each task that
 * adds a door to it adds the file here, with the door in its commit.
 */
const ROSTER_DOORS: readonly string[] = []

describe('the Settings route split', () => {
  it('opens on Runtimes by default, and an old route to agents lands there until the roster exists', () => {
    expect(resolveSection(null)).toBe('runtimes')
    expect(resolveSection('runtimes')).toBe('runtimes')
    expect(resolveSection('agents')).toBe('runtimes')
  })

  it('nothing opens the Agents page but a door that is about Agents', () => {
    const offenders = Object.entries(sources).flatMap(([key, text]) => {
      if (/\.test\.tsx?$/.test(key)) return []
      const where = relativeToSrc(key)
      if (ROSTER_DOORS.includes(where)) return []
      return DOORS.flatMap((door) => [...text.matchAll(door)].map((match) => `${where}: ${match[0]}`))
    })
    expect(offenders).toEqual([])
  })
})
