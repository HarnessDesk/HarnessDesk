import { describe, expect, it } from 'vitest'

import tokens from '../design/foundation/tokens.css?raw'
import themes from './shadcn-themes.css?raw'
import editorial from './editorial.css?raw'
import app from './app.css?raw'

/**
 * A row is one height, in every palette and every interface.
 *
 * `--hd-row-h` is `var(--hd-nav-h)`: a menu item and the rail row it opens
 * from are the same row, and saying so once is what makes an interface dial
 * move both. A block that restates the alias breaks that quietly — the
 * shadcn palette set `--hd-row-h: 32px` beside a `--hd-nav-h` it never
 * mentioned, and the two agreed only because that block also raises the type
 * step and `--hd-nav-h` is solved from the type: 16 × 1.5 + 8 is 32. An
 * arithmetic coincidence is not a contract, and it would have ended the first
 * time somebody moved that palette's body size.
 *
 * So: a scope may move the source. Restating the alias is the thing this
 * refuses, and it reads the sheets rather than a list, so a palette added
 * tomorrow is held by the same rule.
 */

/* Imported rather than read off disk: the renderer talks to the host over the
   wire and never touches the machine, which `check-layering` holds. */
const sheets = [
  { name: 'shadcn-themes.css', source: themes },
  { name: 'editorial.css', source: editorial },
  { name: 'app.css', source: app },
]

describe('the row alias', () => {
  it('is declared once, as the nav row', () => {
    const declarations = [...tokens.matchAll(/^\s*--hd-row-h:\s*([^;]+);/gm)].map((hit) => (hit[1] ?? '').trim())
    expect(declarations).toEqual(['var(--hd-nav-h)'])
  })

  /* The guard on the guard: if the pattern above stops matching, the test
     below passes on an empty search. Three sheets is what there is. */
  it('is reading the sheets that could restate it', () => {
    expect(sheets).toHaveLength(3)
    for (const { name, source } of sheets) expect(source.length, name).toBeGreaterThan(200)
  })

  it('is not restated by any palette or theme block', () => {
    const restated = sheets.flatMap(({ name, source }) =>
      [...source.matchAll(/^\s*--hd-row-h:\s*([^;]+);/gm)].map((hit) => `${name}: --hd-row-h: ${(hit[1] ?? '').trim()}`))
    expect(restated).toEqual([])
  })

  /* A scope that wants taller rows moves `--hd-nav-h`, and the alias follows.
     Studio does exactly that, which is the shape a palette should copy. */
  it('has a source a scope can move', () => {
    const moved = [...tokens.matchAll(/^\s*--hd-nav-h:\s*([^;]+);/gm)].map((hit) => (hit[1] ?? '').trim())
    expect(moved.length).toBeGreaterThan(1)
    expect(moved[0]).toContain('calc(')
  })
})
