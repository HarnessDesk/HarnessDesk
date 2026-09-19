import { describe, expect, it } from 'vitest'

import tokenSheet from '../foundation/tokens.css?raw'
import checkboxSource from './checkbox.tsx?raw'
import radioSource from './radio-group.tsx?raw'
import switchSource from './switch.tsx?raw'
import buttonSource from './button.tsx?raw'
import { buttonVariants } from './button'

/**
 * One button implementation, with every visual decision sourced from the
 * shared component tokens.
 */

describe('the canonical button', () => {
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

  it('never changes the label weight for a chosen state', () => {
    for (const variant of ['row', 'navigation', 'choice'] as const) {
      const classes = buttonVariants({ variant })
      expect(classes).not.toMatch(/(?:data-\[(?:selected|active|current|open|on)\]|aria-checked):font-/)
    }
  })

  /* The weight left, so the fill is now the only mark a chosen row has. Each
     state a caller uses to choose one must carry a fill, or that choice is
     drawn by nothing — the browser contract measures the fills themselves. */
  it('gives every state a caller chooses with a fill of its own', () => {
    const chosen = {
      row: ['data-[selected]', 'data-[current]', 'data-[on]'],
      navigation: ['data-[selected]', 'data-[current]'],
      choice: ['data-[selected]', 'data-[on]', 'aria-checked'],
    } as const
    for (const [variant, states] of Object.entries(chosen)) {
      const classes = buttonVariants({ variant: variant as keyof typeof chosen })
      for (const state of states) {
        expect(classes, `${variant} ${state} has no fill`).toContain(`${state}:bg-`)
      }
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


it('keeps the outline border stable on hover', () => {
  expect(/\boutline:\s*'([^']*)'/.exec(buttonSource)?.[1] ?? '').not.toMatch(/hover:border-/)
})
