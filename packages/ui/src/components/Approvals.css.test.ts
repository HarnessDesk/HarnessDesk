import { describe, expect, it } from 'vitest'

import css from './Approvals.module.css?raw'

/**
 * An approval's answers in a narrow pane, read as text.
 *
 * jsdom implements no container queries, so a rendered test cannot see this
 * rule at all; it is held to the stylesheet instead, the way the header's
 * folds are (`Conversation.css.test.ts`). The card is as wide as its pane
 * allows, so the backdrop — the pane's width — is what the answers ask.
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

describe("an approval's answers in a narrow pane", () => {
  it('are sized by the pane the card sits in', () => {
    expect(blockAfter('.backdrop {')).toMatch(/container:\s*hd-approval\s*\/\s*inline-size/)
  })

  it('wrap below 460px and share their lines, with nothing holding them apart', () => {
    const narrow = blockAfter('@container hd-approval (max-width: 460px)')
    expect(narrow).toMatch(/\.footer\s*\{[^}]*flex-wrap:\s*wrap/)
    expect(narrow).toMatch(/\.spacer\s*\{[^}]*display:\s*none/)
    expect(narrow).toMatch(/\.button\s*\{[^}]*flex:\s*1 1 auto/)
  })
})
