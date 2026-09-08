import { describe, expect, it } from 'vitest'

import themes from './shadcn-themes.css?raw'
import platform from './design-platform.css?raw'
import tokens from '../design/tokens.css?raw'

/**
 * The shadcn palette has the same one failure mode the editorial palette
 * does: an alias it forgets to override falls through to the design
 * platform's value and a cool blue leaks into the neutral page — no error,
 * no test, just a wrong chip somewhere. So the sheet is pinned to the
 * platform's alias list the same way (see editorial-tokens.test.ts): every
 * alias and specific token the platform defines, in both faces, must be
 * re-grounded in the matching face.
 *
 * The accent and corner blocks that follow the two palette faces are
 * deliberately partial — varying one dial is their entire job — so only the
 * first two blocks are held to the coverage rule.
 */

/** Custom-property names defined in the nth `{…}` block of a sheet. */
const definedIn = (css: string, block: number): Set<string> => {
  const bodies = [...css.matchAll(/\{([^}]*)\}/g)].map((match) => match[1] ?? '')
  return new Set([...(bodies[block] ?? '').matchAll(/(--hdp-[\w-]+)\s*:/g)].map((m) => m[1] ?? ''))
}

describe('shadcn-themes.css', () => {
  // design-platform.css: blocks 0/1 are the static ramps, 2/3 the aliases.
  // shadcn-themes.css: block 0 is the light face, block 1 the dark face.
  const aliases = { light: definedIn(platform, 2), dark: definedIn(platform, 3) }
  const covers = { light: definedIn(themes, 0), dark: definedIn(themes, 1) }

  it('is reading real sheets', () => {
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
    expect(themes).not.toMatch(/--hdp-static-(?:blue|accent)/)
  })
})

/**
 * The Corners dial has to move the *whole* shape ladder.
 *
 * A dial that redefines all but one rung is not a smaller change, it is a
 * broken one: the rung it misses keeps the default sheet's value and stands
 * out among the ones that moved. That happened the day `--hd-radius-md` was
 * added — the button's own rung — and neither face's block knew, so Square
 * shipped an 8px button between 4px chips and a 6px card.
 *
 * Read from the token file rather than listed here, so a new rung is caught by
 * the same test on the day it is written — and so is a rung that goes away,
 * which is how `--hd-radius-bubble` left: it was a sixth rung named after one
 * component, and both blocks had to be told.
 */
describe('the Corners dial', () => {
  const ladder = [
    ...new Set(
      [...tokens.matchAll(/^\s*(--hd-radius(?:-[a-z]+)?)\s*:/gm)].map((hit) => hit[1] ?? ''),
    ),
  ].filter((name) => name !== '--hd-radius-full')

  /* The guard on the guard: if the pattern above ever stops matching, every
     rung is trivially "redefined" and the two tests below pass on an empty
     list. Four is the ladder as it stands — sm, md, the base, lg — and the
     floor only has to be high enough that an empty or half-read match fails
     here rather than passing silently there. */
  it('is reading the ladder', () => {
    expect(ladder).toContain('--hd-radius-sm')
    expect(ladder).toContain('--hd-radius-md')
    expect(ladder.length).toBeGreaterThanOrEqual(4)
  })

  for (const corners of ['square', 'round'] as const) {
    it(`redefines every rung under ${corners}`, () => {
      const block = new RegExp(
        `body\\[data-hd-corners='${corners}'\\]\\s*\\{([^}]*)\\}`,
      ).exec(themes)?.[1]
      expect(block, `no ${corners} block`).toBeTruthy()
      const missing = ladder.filter((name) => !new RegExp(`${name}\\s*:`).test(block ?? ''))
      expect(missing, `${corners} leaves these at the default: ${missing.join(', ')}`).toEqual([])
    })
  }
})
