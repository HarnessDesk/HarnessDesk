import { describe, expect, it } from 'vitest'

import editorial from './editorial.css?raw'
import platform from './design-platform.css?raw'

/**
 * The editorial palette's one failure mode is silence: an alias it forgets to
 * override falls through to the design platform's value and a cool blue leaks
 * into the warm page — no error, no test, just a wrong chip somewhere. So the
 * sheet is pinned to the platform's alias list mechanically: every alias and
 * specific token the platform defines, in both faces, must be re-grounded by
 * editorial.css in the matching face.
 */

/** Custom-property names defined in the nth `{…}` block of a sheet. */
const definedIn = (css: string, block: number): Set<string> => {
  const bodies = [...css.matchAll(/\{([^}]*)\}/g)].map((match) => match[1] ?? '')
  return new Set([...(bodies[block] ?? '').matchAll(/(--hdp-[\w-]+)\s*:/g)].map((m) => m[1] ?? ''))
}

describe('editorial.css', () => {
  // design-platform.css: blocks 0/1 are the static ramps, 2/3 the aliases.
  // editorial.css: block 0 is the light face, block 1 the dark face.
  const aliases = { light: definedIn(platform, 2), dark: definedIn(platform, 3) }
  const covers = { light: definedIn(editorial, 0), dark: definedIn(editorial, 1) }

  it('is reading real sheets', () => {
    // The guard against going quiet again: every assertion below is a filter
    // over these sets, so an empty one passes while checking nothing.
    expect(aliases.light.size).toBeGreaterThan(0)
    expect(aliases.dark.size).toBeGreaterThan(0)
    expect(covers.light.size).toBeGreaterThan(0)
    expect(covers.dark.size).toBeGreaterThan(0)
  })

  it('re-grounds every alias the platform defines, in both faces', () => {
    for (const face of ['light', 'dark'] as const) {
      const missing = [...aliases[face]].filter((token) => !covers[face].has(token))
      expect(missing, `${face} face leaks the platform value for: ${missing.join(', ')}`).toEqual(
        [],
      )
    }
  })

  it('never reaches into the platform static ramps, whose blues it exists to retire', () => {
    expect(editorial).not.toMatch(/--hdp-static-(?:blue|accent)/)
  })
})
