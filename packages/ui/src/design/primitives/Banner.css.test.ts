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
  })

  it('centres one-line text and controls, with a wrapped lead on line one', () => {
    const banner = blockAfter(".banner[data-slot='alert'] {")
    const text = blockAfter('.text {')
    expect(banner).toMatch(/align-items:\s*center/)
    expect(text).toMatch(/justify-content:\s*center/)
    expect(text).toMatch(/min-height:\s*var\(--hd-btn-h\)/)
    expect(blockAfter('.banner[data-wrapped] .icon {')).toMatch(/align-self:\s*flex-start/)
    expect(blockAfter('.dismiss {')).not.toMatch(/margin-top:/)
  })
})
