import { describe, expect, it } from 'vitest'

import kitSheet from '../primitives/Kit.module.css?raw'
import tokenSheet from '../tokens.css?raw'
import checkboxSource from './checkbox.tsx?raw'
import radioSource from './radio-group.tsx?raw'
import switchSource from './switch.tsx?raw'
import buttonSource from './button.tsx?raw'
import { buttonVariants } from './button'

/**
 * One button, two spellings, one source of numbers.
 *
 * While surfaces migrate from Kit to the shadcn layer, the app carries two
 * button implementations — and the contract (AGENTS.md, design/index.ts) is
 * that they may never disagree about what a button *is*: both read the
 * `--hd-btn-*` component tokens, so a foundation that remaps them (Pill,
 * Squared) restyles every button at once, and a sizing or focus fix is a
 * token edit rather than a hunt across idioms. This pins the coupling from
 * both sides; the failure mode it exists for is someone vendoring a fresh
 * copy of button.tsx and shipping its stock `h-9` back in.
 */

describe('the button, in both spellings', () => {
  it('the shadcn Button draws every number from the component tokens', () => {
    const base = buttonVariants({})
    expect(base).toContain('h-(--hd-btn-h)')
    expect(base).toContain('p-(--hd-btn-padding)')
    expect(base).toContain('rounded-(--hd-btn-radius)')
    expect(base).toContain('font-(--hd-btn-weight)')
    /* The label size, which is the one number that had already drifted: this
       spelling carried Tailwind's `text-sm` (13px here) while Kit's `.btn`
       set `--hd-text` (14px), and nothing failed. */
    expect(base).toContain('text-(length:--hd-btn-text)')

    expect(buttonVariants({ size: 'sm' })).toContain('h-(--hd-btn-h-sm)')
    expect(buttonVariants({ size: 'sm' })).toContain('p-(--hd-btn-padding-sm)')
    /* The small rung steps its label down with its box. Keeping the default's
       label in a shorter box is exactly the proportion the ratio note in
       tokens.css exists to prevent, and it is what this app used to draw. */
    expect(buttonVariants({ size: 'sm' })).toContain('text-(length:--hd-btn-text-sm)')
    expect(buttonVariants({ size: 'icon' })).toContain('size-(--hd-btn-h)')

    const primary = buttonVariants({ variant: 'default' })
    expect(primary).toContain('bg-(--hd-btn-primary-fill)')
    expect(primary).toContain('text-(--hd-btn-primary-foreground)')
    expect(primary).toContain('hover:bg-(--hd-btn-primary-hover)')

    expect(buttonVariants({ variant: 'outline' })).toContain('border-(--hd-btn-border)')

    /* The destructive button is the one both spellings used to draw
       differently — solid red here, soft danger-ink in Kit. It is soft in
       both now, from the same two names. */
    const danger = buttonVariants({ variant: 'destructive' })
    expect(danger).toContain('text-(--hd-btn-danger-ink)')
    expect(danger).toContain('hover:bg-(--hd-btn-danger-hover)')
  })

  it('never hard-codes a height the tokens are supposed to own', () => {
    /* `lg` is the one deliberate exception and says so in the source; every
       other size resolves through a token. This is the check that catches a
       fresh vendor pasting the registry's stock `h-8`/`h-7`/`size-8` back in. */
    for (const size of ['default', 'sm', 'icon', 'icon-sm'] as const) {
      expect(buttonVariants({ size }), `size=${size} stopped reading a token`).toMatch(
        /(h|size)-\(--hd-btn-h/,
      )
    }
  })

  it('Kit’s Btn reads the same tokens, so neither spelling owns the numbers', () => {
    for (const token of [
      '--hd-btn-h',
      '--hd-btn-h-sm',
      '--hd-btn-padding',
      '--hd-btn-radius',
      '--hd-btn-text',
      '--hd-btn-text-sm',
      '--hd-btn-weight',
      '--hd-btn-border',
      '--hd-btn-primary-fill',
      '--hd-btn-primary-foreground',
      '--hd-btn-primary-hover',
      '--hd-btn-danger-ink',
      '--hd-btn-danger-hover',
    ]) {
      expect(kitSheet, `Kit.module.css stopped reading ${token}`).toContain(`var(${token})`)
    }
  })
})

/**
 * Ink is for what you press; the accent is for what is yours.
 *
 * The split is one family in tokens.css (`--hd-solid`) and it is worth a test
 * because it is invisible in every diff that breaks it: pointing the button
 * back at `--hd-primary` looks like a one-word tidy-up and quietly puts the
 * brand blue back on every action in the app. What is pinned here is the
 * *wiring*, not the colour — the values move with the palette, the accent dial
 * and the theme, and that is the point.
 */
describe('the button is ink, not the brand', () => {
  it('the filled button reads the solid through its own component tokens', () => {
    expect(tokenSheet).toMatch(/--hd-btn-primary-fill:\s*var\(--hd-solid\)/)
    expect(tokenSheet).toMatch(/--hd-btn-primary-hover:\s*var\(--hd-solid-hover\)/)
    expect(tokenSheet).toMatch(/--hd-btn-primary-foreground:\s*var\(--hd-solid-foreground\)/)
  })

  it('leaves the accent to the things that identify rather than shout', () => {
    /* The brand is still the brand: the focus ring, the selected row, the ink
       a link is set in. A change that collapses these onto the solid takes the
       Accent dial away from the user. */
    expect(tokenSheet).toMatch(/--hd-ring:\s*var\(--hd-accent\)/)
    expect(tokenSheet).toMatch(/--hd-primary:\s*var\(--hd-accent\)/)
  })
})

/**
 * A control that is on says so in the accent.
 *
 * These three spent a release on the solid, filed with the button because a
 * switch is a thing you press. A switch is pressed in both states; what the
 * fill marks is that it is *on*, which is a state, and states are the accent's
 * half of the split. The visible cost was a black switch one row under the
 * Accent dial itself, on the page whose whole job is to show what the dial
 * does.
 *
 * Pinned because the wrong answer is the tidy-looking one: `--hd-solid` reads
 * as "the loud fill" and will attract this back if nothing objects.
 */
describe('the on-states follow the accent dial', () => {
  it('the three of them read the accent, and the knob reads what sits on it', () => {
    expect(tokenSheet).toMatch(/--hd-toggle-on:\s*var\(--hd-accent\)/)
    /* Not a value of its own: `--hd-primary-foreground` is already solved per
       accent and per face — white where it carries, dark ink on green, orange
       and the lighter rose and mono dark faces. */
    expect(tokenSheet).toMatch(/--hd-toggle-knob-on:\s*var\(--hd-primary-foreground\)/)
  })

  it('reaches them through the toggle tokens, so a foundation swap carries', () => {
    for (const sheet of [switchSource, radioSource, checkboxSource]) {
      expect(sheet).toContain('--hd-toggle-on')
      expect(sheet).not.toContain('--hd-primary')
    }
  })
})


/**
 * `outline` means one thing, and two files have to agree about it.
 *
 * This is the coupling the usage layer exists to create, and it was the one
 * thing about it with no test: Kit had no `outline` at all until recently, so
 * a screen built on it fell back to grey and three "add a thing" buttons in
 * one settings window came out three different ways. Adding the variant fixed
 * the screens; nothing stopped the two definitions drifting apart again.
 *
 * The comparison is the *tokens*, not the syntax, because the two spellings
 * cannot share syntax — one is a CSS rule and the other a string of Tailwind
 * utilities. Both are read as raw text, so the CSS is the real stylesheet
 * rather than the empty string Vitest hands back for an imported `.css`.
 */
describe('outline is the same variant in both spellings', () => {
  /** Every `--hd-` token a chunk of styling names. */
  const tokensIn = (text: string) => new Set([...text.matchAll(/--hd-[a-z0-9-]+/g)].map((hit) => hit[0]))

  /** The declarations of every rule whose selector mentions `selector`. */
  const rulesFor = (sheet: string, selector: string) =>
    [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((rule) => (rule[1] ?? '').includes(selector))
      .map((rule) => rule[2])
      .join('\n')

  it('names the same tokens on both sides', () => {
    const kit = tokensIn(rulesFor(kitSheet, "[data-variant='outline']"))
    const shadcn = tokensIn(/\boutline:\s*'([^']*)'/.exec(buttonSource)?.[1] ?? '')

    /* Not vacuous in either direction: both sides have to have been found. */
    expect(kit.size).toBeGreaterThan(0)
    expect(shadcn.size).toBeGreaterThan(0)
    expect([...kit].sort()).toEqual([...shadcn].sort())

    /* And they are these, so a drift that happened to move both together
       still has to be a deliberate edit here. */
    expect([...kit].sort()).toEqual(['--hd-background', '--hd-btn-border', '--hd-foreground', '--hd-hover'])
  })

  it('does not move its border on hover in either spelling', () => {
    /* The rest-state comparison above passed while the two hovered
       differently: Kit's base `.btn:hover` moves the border to a darker
       platform step, and the outline rule did not override it, so the same
       semantic variant hovered one way in Kit and another in shadcn. A parity
       check that reads only the outline-specific rules cannot see an
       inherited declaration, so the invariant is stated directly. */
    expect(rulesFor(kitSheet, "[data-variant='outline']:hover")).toContain('border-color: var(--hd-btn-border)')
    expect(/\boutline:\s*'([^']*)'/.exec(buttonSource)?.[1] ?? '').not.toMatch(/hover:border-/)
  })
})
