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

describe('a banner in a narrow column', () => {
  it('is framed by a box its own layout can query, and by nothing that contains its layout', () => {
    expect(blockAfter('.frame {')).toMatch(/container:\s*hd-banner\s*\/\s*inline-size/)
    /* A query container, measured in #192's review to neither move a fixed
       child nor trap its stacking; `contain: layout` would do both, and the ×
       menu inside the card is fixed and not portalled. */
    expect(blockAfter('.frame {')).not.toMatch(/(^|[\s;{])contain:/)
  })

  it('gives its actions a line of their own below 600px, after the words — and leaves a compact banner be', () => {
    const narrow = blockAfter('@container hd-banner (max-width: 600px)')
    expect(narrow).toMatch(/\.banner:not\(\[data-compact\]\)\s*\{[^}]*flex-wrap:\s*wrap/)
    expect(narrow).toMatch(/\.banner:not\(\[data-compact\]\) \.actions\s*\{[^}]*order:\s*1;[^}]*flex-basis:\s*100%/)
  })
})
