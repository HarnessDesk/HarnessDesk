import { describe, expect, it } from 'vitest'

import css from './WindowControls.module.css?raw'

/**
 * The window's own controls in a narrow header, read as text.
 *
 * jsdom implements no container queries, so a rendered test cannot see this
 * fold; it is held to the stylesheet instead, the way the header's other folds
 * are (`Conversation.css.test.ts`).
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

describe("the window's controls in a narrow header", () => {
  it('fold the arrows at 520px and keep the sidebar toggle', () => {
    /* The toggle is the one press that reaches the sidebar, which carries its
       own pair of arrows. Nothing read this stylesheet before, so the fold
       could have gone without anything going red. */
    const narrow = blockAfter('@container hd-header (max-width: 520px)')
    expect(narrow).toMatch(/\.nav\s*\{[^}]*display:\s*none/)
    // Every control but the arrows stays: nothing folds the buttons as such.
    expect(narrow).not.toMatch(/\.button\s*[,{]/)
  })
})
