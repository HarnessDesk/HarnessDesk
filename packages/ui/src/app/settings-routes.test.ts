import { describe, expect, it } from 'vitest'

import { resolveSection } from '../components/Settings'

/**
 * The route id `agents` is reused, and its old meaning is retired for good.
 *
 * It named the page of installed CLIs and their accounts; that page is
 * `runtimes` now, and the redirect below is permanent — no later task hands
 * the id back to a page in Settings. The roster of Agents lives in its own
 * left-menu window instead, never in Settings. `MOVED` cannot carry an id
 * that still exists, so every door that meant the CLIs — a sign-in, an "add
 * another", ⌘, — moved to `runtimes` by hand, and this is the test that
 * nothing was left behind asking Settings for a sign-in on the roster's
 * behalf.
 *
 * The roster's own door is `openAgents`, opened by the shell action, the
 * palette and a handful of pages that point at one Agent — audited on its
 * own, below, never as an exemption from the Settings check.
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

/**
 * Every way the renderer spells a door to Settings on the retired `agents`
 * id. None of these is ever legitimate again — the roster's own door,
 * `openAgents`, is checked separately below — so this list carries no
 * exemption of its own.
 */
const DOORS: readonly RegExp[] = [
  /\b(?:setSettingsOpen|askSettings|openSettings|onOpenSettings|onSection)\(\s*'agents'/g,
  /\?\?\s*'agents'\s*\)/g,
  /\bsection\s*=\s*'agents'/g,
  /\bfallback:\s*Section\s*=\s*'agents'/g,
]

/**
 * The files allowed to call `openAgents`, the Agents window's own door — not
 * a door to Settings, which never legitimately opens on the retired roster
 * id. Each task that gives a surface a genuine door to it names the file
 * here, with the door in its own commit.
 */
const ROSTER_DOORS: readonly string[] = [
  // The shell action itself (`ShellActions.openAgents`), and the effect that
  // takes a seat's fix where it is fixed.
  'app/App.tsx',
  // "Open <Agent>".
  'components/CommandPalette.tsx',
]

describe('the Settings route split', () => {
  it('opens on Runtimes by default, and the retired agents route redirects there for good', () => {
    expect(resolveSection(null)).toBe('runtimes')
    expect(resolveSection('runtimes')).toBe('runtimes')
    expect(resolveSection('agents')).toBe('runtimes')
  })

  it('nothing spells a new door to Settings on the retired agents id', () => {
    const offenders = Object.entries(sources).flatMap(([key, text]) => {
      if (/\.test\.tsx?$/.test(key)) return []
      const where = relativeToSrc(key)
      return DOORS.flatMap((door) => [...text.matchAll(door)].map((match) => `${where}: ${match[0]}`))
    })
    expect(offenders).toEqual([])
  })

  it("only the roster's own doors call openAgents", () => {
    const offenders = Object.entries(sources).flatMap(([key, text]) => {
      if (/\.test\.tsx?$/.test(key)) return []
      const where = relativeToSrc(key)
      if (ROSTER_DOORS.includes(where)) return []
      return [...text.matchAll(/\bopenAgents\(/g)].map(() => where)
    })
    expect(offenders).toEqual([])
  })
})
