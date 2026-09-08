import { expect, it } from 'vitest'

import css from './Markdown.module.css?raw'
import shadcn from '../styles/shadcn.css?raw'

/**
 * Markdown prose keeps its list markers.
 *
 * The bug this pins was invisible for as long as nobody read a numbered list
 * in the app: `shadcn.css` resets `list-style: none` on every `ul`/`ol` under
 * a `[data-slot]` ancestor — correct for the component lists it was written
 * for, a menu being not prose — and `Markdown` renders inside those
 * components everywhere. So an agent writing `1. 2. 3.` produced three
 * indented sentences with nothing to say they were a sequence, and a
 * `SKILL.md` whose procedure is numbered read as loose prose.
 *
 * Asserted against the stylesheet text rather than a computed style: jsdom
 * does not load the app's global sheets in a component test, so a
 * `getComputedStyle` check here would pass whether or not the reset existed
 * and would be exactly the vacuous green this repository has been caught by
 * before. What can be checked honestly is that the reset is still there and
 * that this module still answers it.
 */

/**
 * Every declaration that applies to one selector, from every rule that names
 * it.
 *
 * Not a substring search from the first hit: `.markdown ol` appears twice —
 * once in the `ul, ol` rule that sets the margins and once in its own rule
 * that sets the marker — and taking the first block found returns the
 * margins and reports a missing marker that is right there.
 */
const declarations = (selector: string): string => {
  const found: string[] = []
  for (const rule of css.split('}')) {
    const open = rule.indexOf('{')
    if (open === -1) continue
    // Comments come off *before* the split: a comment above a rule is part
    // of this chunk, and one containing a comma splits the selector into
    // fragments that match nothing. Which is exactly what happened.
    const names = rule
      .slice(0, open)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((one) => one.trim())
    if (names.includes(selector)) found.push(rule.slice(open + 1))
  }
  expect(found.length, `${selector} should be in Markdown.module.css`).toBeGreaterThan(0)
  return found.join('\n')
}

it('the reset that strips markers is still the thing being answered', () => {
  // If this ever goes away the rules below are harmless but pointless, and
  // whoever removed it should be told the two are related.
  expect(shadcn).toContain(':where([data-slot]) :where(ul, ol)')
  expect(shadcn.slice(shadcn.indexOf(':where([data-slot]) :where(ul, ol)'))).toContain(
    'list-style: none',
  )
})

it('prose lists declare their own markers, so the reset cannot silence them', () => {
  expect(declarations('.markdown ul')).toContain('list-style: disc')
  expect(declarations('.markdown ol')).toContain('list-style: decimal')
})

it('nested levels change shape rather than repeating the one above', () => {
  expect(declarations('.markdown li > ul')).toContain('list-style: circle')
})
