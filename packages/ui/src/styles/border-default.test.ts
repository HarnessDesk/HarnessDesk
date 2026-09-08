import { expect, it } from 'vitest'

import raw from './shadcn.css?raw'

/*
 * Comments come off before anything is parsed. This file's own note quotes
 * shadcn's `@layer base { * { @apply border-border } }`, and a brace inside a
 * comment derails every split-on-`}` parser — which is how the first version
 * of this test reported a missing rule that was six lines above it.
 */
const bridge = raw.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Tailwind's `border` utility must resolve to the app's hairline, not to ink.
 *
 * Tailwind v4 dropped v3's grey default and leaves an unqualified `border`
 * painting in `currentColor`. On a page of near-black text that is a 1px
 * black rule, and it is invisible in review because nothing errors — every
 * token check passes, the class name looks right, and the box is simply
 * wrong. Measured in the running app before this rule existed: the Library
 * page's banner drew `1px rgb(15, 17, 21)` while Kit's own container, two
 * rows up the settings sidebar, drew `1px rgba(0, 0, 0, 0.04)`. Two pages
 * that did not look like the same product, from one missing line.
 *
 * Pinned against the stylesheet text rather than a computed style: the rule
 * is global, so a component test would have to mount the whole bridge to see
 * it and would pass whether or not it was there — the vacuous green this
 * repository has been caught by before.
 */

/** The declarations of the first rule whose selector list includes `sel`. */
const ruleFor = (sel: string): string | null => {
  for (const rule of bridge.split('}')) {
    const open = rule.indexOf('{')
    if (open === -1) continue
    const names = rule
      .slice(0, open)
      .split(',')
      .map((one) => one.trim())
      .filter((one) => one !== '')
    if (names.includes(sel)) return rule.slice(open + 1)
  }
  return null
}

it('every element defaults to the design system’s border colour', () => {
  const body = ruleFor('*')
  expect(body, 'shadcn.css should carry a `*` border-color default').not.toBeNull()
  expect(body).toContain('border-color: var(--hd-border)')
})

it('the default reaches pseudo-elements, which draw borders too', () => {
  // `::before`/`::after` are how several components draw a rule or a caret;
  // Tailwind's own preflight lists them for exactly this reason.
  for (const pseudo of ['::before', '::after']) {
    expect(ruleFor(pseudo), `${pseudo} should share the default`).toContain(
      'border-color: var(--hd-border)',
    )
  }
})

it('the default is unqualified, so it cannot lose its reach', () => {
  // Scoped to `[data-slot]` first, it missed every element outside a
  // vendored component — a page's own wrapper, a bare bordered div — and
  // those kept painting in ink. Zero specificity is what makes a bare `*`
  // safe: anything that names its own border colour still wins.
  const rule = bridge
    .split('}')
    .find((one) => one.includes('border-color: var(--hd-border)'))
  expect(rule, 'the default should be in the sheet').toBeDefined()
  expect(rule?.slice(0, rule.indexOf('{'))).not.toContain('[data-slot]')
})
