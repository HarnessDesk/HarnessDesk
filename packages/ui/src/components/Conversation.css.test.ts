import { describe, expect, it } from 'vitest'

import css from './Conversation.module.css?raw'

/**
 * What a narrow header folds away, read as text.
 *
 * Vitest stubs CSS modules to the empty string and jsdom implements no
 * container queries, so a rendered test can only see the marker a rule keys
 * on — never the rule. This holds the rules to their markers. At a phone's
 * width the header hides the doors it marked as having a ⋯ to fold into, and
 * no other header button: folding every button hid a draft's browser, which
 * has no ⋯ beside it — found in review, not by anything here. At 520px the
 * words it folds are clipped rather than removed, since each is still its
 * control's name.
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
    // Not every header button.
    expect(phone).not.toMatch(/\.headerButton\s*[,{]/)
  })
})

describe("a narrow header's words", () => {
  it('fold to their marks and are still read out: clipped, never removed', () => {
    /* Two of the four are declared in this block and nowhere else, so without
       it their spans carry no class at all and spell their words out at every
       width — and nothing rendered would notice. */
    const narrow = blockAfter('@container hd-header (max-width: 520px)')
    for (const label of ['.statusLabel', '.tasksLabel', '.gitLabel', '.gitTag']) {
      expect(narrow, `${label} does not fold`).toContain(label)
    }
    expect(narrow).toMatch(/clip-path:\s*inset\(50%\)/)
    // Removed, a word would no longer be its control's name.
    expect(narrow).not.toMatch(/display:\s*none/)
  })
})
