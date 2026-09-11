import { describe, expect, it } from 'vitest'

import css from './Workbench.module.css?raw'

/**
 * The dim over a narrow window, read as text.
 *
 * jsdom paints nothing and hit-tests nothing, so what a press on the fading
 * dim reaches can only be held to the stylesheet — the way the header's folds
 * are (`components/Conversation.css.test.ts`).
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

describe('the dim over a narrow window', () => {
  it('stays in the way while it fades, and goes once it has', () => {
    /* Put away, the sidebar slides out and the dim fades over the same span.
       With its pointer events off the moment the fade began, a press on the
       dim — the second half of Escape-and-click — landed on the conversation
       it was still dimming: the composer took focus 15ms after Escape,
       measured in a real engine. Hidden by visibility once the fade is over,
       the dim takes that press itself, and closing a closed sidebar does
       nothing. */
    const closed = blockAfter('.scrim {')
    expect(closed).toMatch(/visibility:\s*hidden/)
    expect(closed).toMatch(/visibility 0s linear var\(--hdp-transition-duration-slow\)/)
    expect(closed).not.toMatch(/pointer-events:\s*none/)
    expect(blockAfter('.scrim[data-open] {')).toMatch(/visibility:\s*visible/)
  })

  it('leaves the focus order behind it: a sidebar put away is hidden once its slide has finished', () => {
    /* The claim behind "a sidebar that is put away can no longer be reached
       with Tab" — a rule nothing held until now. */
    const hidden = blockAfter('.sidebar[data-hidden] {')
    expect(hidden).toMatch(/visibility:\s*hidden/)
    expect(hidden).toMatch(/visibility 0s linear var\(--hdp-transition-duration-slow\)/)
  })

  it('slides the sidebar out of the way in a narrow window, and draws it in full while it floats', () => {
    const narrow = blockAfter('.shell[data-narrow] .sidebar {')
    expect(narrow).toMatch(/position:\s*absolute/)
    expect(narrow).toMatch(/transform:\s*translateX\(-100%\)/)
    expect(narrow).toMatch(/visibility:\s*hidden/)
    const floating = blockAfter('.shell[data-narrow] .sidebar[data-floating] {')
    expect(floating).toMatch(/transform:\s*none/)
    expect(floating).toMatch(/visibility:\s*visible/)
  })

  it('lays a right panel over the conversation in a narrow window', () => {
    expect(blockAfter('.shell[data-narrow] .right {')).toMatch(/position:\s*absolute;[^}]*inset:\s*0/)
  })

  it('has no fade to wait out when motion is reduced', () => {
    /* The app shortens every transition's duration then, but not a delay:
       without this the dim would be gone at once and still in the way,
       unseen, for the whole span. */
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.scrim\s*\{\s*transition:\s*none;?\s*\}\s*\}/)
  })
})
