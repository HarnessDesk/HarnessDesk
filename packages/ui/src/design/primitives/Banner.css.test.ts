import { describe, expect, it } from 'vitest'

import css from './Banner.module.css?raw'

/**
 * A banner's fold, read as text.
 *
 * jsdom implements no container queries, so a rendered test cannot see this
 * rule at all; it is held to the stylesheet instead, the way the header's
 * folds are (`components/Conversation.css.test.ts`). The frame is the query
 * container rather than the card because a box cannot query its own width.
 */

/** A block's body, braces balanced, with its comments taken out. */
const blockAfter = (opening: string): string => {
  const at = css.indexOf(opening)
  expect(at, `${opening} is gone from this stylesheet`).toBeGreaterThan(-1)
  const start = css.indexOf('{', at)
  let depth = 0
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start, index + 1).replace(/\/\*[\s\S]*?\*\//g, '')
    }
  }
  throw new Error(`${opening} never closes`)
}

describe('banner centring', () => {
  it('keeps the card inside its width boundary without containing its contents', () => {
    expect(blockAfter('.frame {')).toMatch(/width:\s*min\(var\(--hd-column\),\s*100%\)/)
    expect(blockAfter('.frame {')).not.toMatch(/(^|[\s;{])contain:/)
    expect(blockAfter('.frame {')).toMatch(/container:\s*hd-banner\s*\/\s*inline-size/)
  })

  it('fills its parent when a wider page block owns the banner measure', () => {
    expect(blockAfter(".frame[data-measure='container'] {")).toMatch(/width:\s*100%/)
    expect(blockAfter(".frame[data-measure='container'] .banner {")).toMatch(/width:\s*100%/)
  })

  it('moves every size below the copy when narrow or given three actions', () => {
    const actions = blockAfter('.banner .actions {')
    expect(actions).toMatch(/grid-column:\s*2 \/ -1/)
    expect(actions).toMatch(/grid-row:\s*2/)
    expect(blockAfter('.banner[data-stack] .actions {')).toMatch(/grid-row:\s*2/)
    expect(css).toContain('@container hd-banner (max-width: 400px)')
  })

  it('centres the tile on the whole text block and pins only the wrapped dismiss to the top', () => {
    expect(blockAfter('.banner {')).toMatch(/align-items:\s*center/)
    expect(blockAfter('.text {')).toMatch(/justify-content:\s*center/)
    expect(blockAfter('.icon {')).toMatch(/align-self:\s*center/)
    expect(blockAfter('.banner[data-wrapped] .dismiss {')).toMatch(/align-self:\s*start/)
    expect(css).not.toMatch(/margin-top:/)
  })
})
