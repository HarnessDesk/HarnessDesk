import { describe, expect, it } from 'vitest'

import css from '../design/patterns/ApprovalDialog.module.css?raw'

/**
 * An approval's answers in a narrow pane, read as text.
 *
 * jsdom implements no container queries, so a rendered test cannot see this
 * rule at all; it is held to the stylesheet instead, the way the header's
 * folds are (`Conversation.css.test.ts`). The card is as wide as its pane
 * allows, so the backdrop — the pane's width — is what the answers ask.
 */

/** A block's body, braces balanced, with its comments taken out. */
const blockAfter = (opening: string, source = css): string => {
  source = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const escaped = opening.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const at = source.search(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{`))
  expect(at, `${opening} is gone from this stylesheet`).toBeGreaterThan(-1)
  const start = source.indexOf('{', at)
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1).replace(/\/\*[\s\S]*?\*\//g, '')
    }
  }
  throw new Error(`${opening} never closes`)
}

describe("an approval's answers in a narrow pane", () => {
  it('finds the viewport despite comments, spacing and declaration order', () => {
    const source = `.viewportExtra { container: wrong / inline-size; }
      .viewport  /* pane viewport */ { bottom: 0; container: hd-approval / inline-size; z-index: 10; }`
    expect(blockAfter('.viewport', source)).toMatch(/container:\s*hd-approval\s*\/\s*inline-size/)
  })

  it('are sized by the pane the card sits in', () => {
    expect(blockAfter('.viewport')).toMatch(/container:\s*hd-approval\s*\/\s*inline-size/)
  })

  it('wrap below 460px and share their lines, with nothing holding them apart', () => {
    const narrow = blockAfter('@container hd-approval (max-width: 460px)')
    expect(narrow).toMatch(/\.footer\s*\{[^}]*flex-wrap:\s*wrap/)
    expect(narrow).toMatch(/\.spacer\s*\{[^}]*display:\s*none/)
    expect(narrow).toMatch(/\.action\s*\{[^}]*flex:\s*1 1 auto/)
  })
})
