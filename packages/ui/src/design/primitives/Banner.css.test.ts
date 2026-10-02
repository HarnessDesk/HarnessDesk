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

  it('moves non-compact actions below the copy when the card is narrow', () => {
    expect(css).toMatch(/@container hd-banner \(max-width:\s*400px\)\s*\{[\s\S]*?\.banner:not\(\[data-compact\]\)\s*\{[^}]*flex-wrap:\s*wrap/s)
    const actions = blockAfter('.banner:not([data-compact]) .actions {')
    expect(actions).toMatch(/order:\s*1/)
    expect(actions).toMatch(/flex-basis:\s*100%/)
    expect(actions).toMatch(/justify-content:\s*flex-end/)
    expect(actions).toMatch(/padding-left:\s*0/)
  })

  it('centres one-line text and controls, with a wrapped lead on line one', () => {
    const banner = blockAfter(".banner[data-slot='alert'] {")
    const text = blockAfter('.text {')
    expect(banner).toMatch(/align-items:\s*center/)
    expect(text).toMatch(/justify-content:\s*center/)
    expect(text).toMatch(/min-height:\s*var\(--hd-btn-h\)/)
    expect(blockAfter('.banner[data-wrapped] .icon {')).toMatch(/align-self:\s*flex-start/)
    // One line: the dismiss shares the centre. Wrapped: it hangs from the top and is pulled onto the title's line.
    expect(blockAfter('.dismiss {')).not.toMatch(/margin-top:/)
    const wrappedDismiss = blockAfter('.banner[data-wrapped] .dismiss {')
    expect(wrappedDismiss).toMatch(/align-self:\s*flex-start/)
    expect(wrappedDismiss).toMatch(/margin-top:\s*calc\(\(var\(--hd-line\) - var\(--hd-btn-h-sm\)\) \/ 2\)/)
    expect(blockAfter('.banner[data-wrapped][data-compact] .dismiss {')).toMatch(/var\(--hd-icon-target\)/)
  })
})
