import { describe, expect, it } from 'vitest'

import css from './Conversation.module.css?raw'

/**
 * What a phone-width header folds away, read as text.
 *
 * Vitest stubs CSS modules to the empty string and jsdom implements no
 * container queries, so a rendered test can only see the marker a rule keys
 * on — never the rule. This holds the rule to the marker: at a phone's width
 * the header hides the doors it marked as having a ⋯ to fold into, and no
 * other header button. Folding every button hid a draft's browser, which has
 * no ⋯ beside it — found in review, not by anything here.
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

describe("a phone's header", () => {
  it('folds only the doors marked as having a ⋯ to fold into', () => {
    const phone = blockAfter('@container hd-header (max-width: 400px)')
    expect(phone).toMatch(/\.headerButton\[data-folds\]/)
    // Not every header button, and not by the old class that folded them all.
    expect(phone).not.toMatch(/\.headerButton\s*[,{]/)
    expect(phone).not.toMatch(/\.viewButton/)
  })
})
