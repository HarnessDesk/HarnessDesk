import { expect, it } from 'vitest'

import composerCss from '../../components/Composer.module.css?raw'
import buttonTsx from './button.tsx?raw'
import composerTsx from './composer.tsx?raw'
import textareaTsx from './textarea.tsx?raw'

/**
 * The two composers are one shape.
 *
 * `components/Composer.tsx` draws the conversation's box from a CSS module;
 * `design/ui/composer.tsx` draws the same box from utilities, for every other
 * surface that needs somewhere to type — the room, the mocks, the previews.
 * Two implementations of one thing is a drift waiting to happen, and it had
 * already happened: the room's box wore a lighter edge, a shallower shadow,
 * tighter text padding, an accent ring on focus the conversation has never
 * had, and a rectangular Send where the conversation has a round ink coin.
 * All five were invisible until the two sat one keystroke apart, which is
 * exactly where they sit.
 *
 * Merging them into one implementation would mean either a CSS module inside
 * the shadcn layer, which that layer does not have, or rewriting the app's
 * most-tested component to earn it. Neither is worth doing blind. So they stay
 * two, and this reads the module and fails if the shape moves in one file
 * without the other.
 *
 * The arrow points one way: **the module is the source.** If this fails
 * because `Composer.module.css` changed on purpose, copy the new value into
 * `design/ui/composer.tsx` and update the expectation here — do not relax it.
 */

/** The declarations the shell copies, and what it must copy them as. */
const SHARED: readonly {
  readonly what: string
  /** What `Composer.module.css` must still say. */
  readonly css: string
  /** What `design/ui/composer.tsx` must still carry. */
  readonly utility: string
}[] = [
  {
    what: 'the corner',
    css: 'border-radius: var(--hd-radius-lg)',
    utility: 'rounded-(--hd-radius-lg)',
  },
  {
    what: 'the resting shadow',
    css: '0 1px 3px rgba(0, 0, 0, 0.06)',
    utility: 'shadow-[0_1px_3px_rgba(0,0,0,0.06)]',
  },
  {
    what: 'the hairline',
    css: 'inset 0 0 0 1px var(--hd-border-emphasis)',
    utility: 'ring-(--hd-border-emphasis)',
  },
  {
    /* The whole utility, not the tail of it.
     *
     * When the Studio ring was prepended this row was loosened to the raw
     * substring `0_2px_10px_rgba(0,0,0,0.08)]`, which is a weaker claim than it
     * looks: it would pass on a `shadow-[…]` that had lost the ring, on a
     * `hover:` variant of the same value, on anything ending in those
     * characters. A parity row that can be satisfied by the wrong class is not
     * pinning the shape. */
    what: 'the focused shadow',
    css: '0 2px 10px rgba(0, 0, 0, 0.08)',
    utility: 'focus-within:shadow-[var(--hd-composer-ring,0_0_0_0_transparent),0_2px_10px_rgba(0,0,0,0.08)]',
  },
  {
    what: 'the focused hairline',
    css: 'inset 0 0 0 1px var(--hd-border-heavy',
    utility: 'focus-within:ring-(--hd-border-heavy)',
  },
  /*
   * The four below were drift the six above did not cover, found by putting
   * the two boxes side by side rather than by anything failing: the room's
   * text well was set 21px against the conversation's 22px, stopped growing
   * 64px earlier, stood 12px taller at rest (`rows=2` against a 52px floor on
   * one row), and under the Studio interface announced focus without the ring
   * the conversation draws. Each is one declaration, and each was invisible
   * until it was beside its twin.
   */
  {
    /* Kept beside the row above, which now contains it, because the two fail
       with different sentences: "the focused shadow moved" and "the Studio
       ring is gone" are different repairs. */
    what: 'the Studio focus ring',
    css: 'var(--hd-composer-ring, 0 0 0 0 transparent)',
    utility: 'var(--hd-composer-ring,0_0_0_0_transparent)',
  },
]

it.each(SHARED)('$what is the same in both composers', ({ css, utility }) => {
  expect(composerCss).toContain(css)
  expect(composerTsx).toContain(utility)
})

it('both composers use the canonical send coin weights', () => {
  for (const utility of [
    'rounded-full',
    'bg-(--hd-solid)',
    'text-(--hd-solid-foreground)',
    'color-mix(in_srgb,var(--hd-accent)_22%,transparent)',
  ]) {
    expect(buttonTsx).toContain(utility)
    expect(composerTsx).toContain(utility)
  }
})

it('both composers use the canonical text-well measure', () => {
  for (const utility of [
    'leading-(--hd-composer-line)',
    'min-h-(--hd-composer-min)',
    'max-h-(--hd-composer-max)',
  ]) {
    expect(textareaTsx).toContain(utility)
    expect(composerTsx).toContain(utility)
  }
})

it('the shell is the layer-1 surface the conversation sits on', () => {
  // `--hd-card` resolves to `--hd-card`, which is what the module
  // names directly. Both land on the same paint; the token layer is the proof.
  expect(composerCss).toContain('background: var(--hd-card)')
  expect(composerTsx).toContain('bg-(--hd-card)')
})

it('focus deepens the shadow rather than lighting an accent ring', () => {
  // The regression this file was written for. An accent ring on focus is what
  // an input in a form does; the composer is the page's subject, and a box
  // that lights up when you type in it is a box asking for attention it
  // already has.
  expect(composerTsx).not.toContain('focus-within:ring-(--hd-ring)')
  expect(composerCss).not.toContain('--hd-ring')
})

it('the send coin is 30px in both', () => {
  expect(buttonTsx).toContain('size-(--hd-btn-h)')
  expect(composerTsx).toContain('size-7.5')
})
