import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import tokenSheet from '../foundation/tokens.css?raw'
import checkboxSource from './checkbox.tsx?raw'
import radioSource from './radio-group.tsx?raw'
import switchSource from './switch.tsx?raw'
import buttonSource from './button.tsx?raw'
import { Button, buttonVariants } from './button'

/**
 * One button implementation, with every visual decision sourced from the
 * shared component tokens.
 */

describe('the canonical button', () => {
  it('leaves the one focus ring to the platform rule', () => {
    const base = buttonVariants({})
    expect(base).not.toContain('outline-none')
    expect(base).not.toMatch(/focus-visible:(?:border|shadow)-/)
  })

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

    const outline = buttonVariants({ variant: 'outline' })
    expect(outline).toContain('border-(--hd-btn-border)')
    expect(outline.split(/\s+/)).toContain('text-(--hd-foreground)')

    const floating = buttonVariants({ variant: 'floating' })
    expect(floating).toContain('rounded-full')
    expect(floating).toContain('bg-(--hd-card)')
    expect(floating).toContain('var(--hd-shadow-raised)')
    expect(floating).toContain('var(--hd-border-strong)')

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

  it('keeps every row and a wrapped consequence left aligned', () => {
    for (const variant of ['row', 'navigation', 'choice'] as const) {
      expect(buttonVariants({ variant })).toContain('text-left')
    }
  })

  /* The weight left, so the fill is now the only mark a chosen row has. Each
     state a caller uses to choose one must carry a fill, or that choice is
     drawn by nothing — the browser contract measures the fills themselves. */
  it('gives every state a caller chooses with a fill of its own', () => {
    const chosen = {
      row: ['data-[selected]', 'data-[current]', 'data-[on]', 'aria-checked'],
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

  /* A refused row's own dimming is a canonical Button concern (see
     NewSessionChoice.tsx's comment on its `.group` rule): `ghost` and
     `floating` already fade on `data-refused` for a runtime an attachment
     can't reach, so `choice` — the picker variant a refused Agent row also
     uses — must fade the same way rather than reading identically to a
     seatable row (#871). */
  it('fades a refused ghost or floating control as a whole', () => {
    for (const variant of ['ghost', 'floating'] as const) {
      expect(buttonVariants({ variant }), `${variant} does not fade data-refused`).toContain('data-[refused]:opacity-45')
    }
  })

  /*
   * `choice` cannot fade as a whole the way `ghost`/`floating` do: an Agent
   * choice carries its refusal reason in the same control, and a caller
   * measured the review-flagged version at ~1.9:1 in light mode — a reason
   * a person is refused specifically so they can read it has to clear body
   * text contrast, not merely exist. Only the lead glyph and the name fade;
   * the reason (never marked `data-role=row`, the name's own role) keeps
   * its ink.
   */
  it('fades a refused choice by its lead and name only, leaving its reason at full ink', () => {
    const choice = buttonVariants({ variant: 'choice' })
    expect(choice).not.toContain('data-[refused]:opacity-45')
    expect(choice).toContain('data-[refused]:[&_[data-slot=icon-tile]]:opacity-45')
    expect(choice).toContain('data-[refused]:[&_[data-role=row]]:opacity-45')
  })

  it('carries navigation ink into named text roles and owns arrange markers', () => {
    const navigation = buttonVariants({ variant: 'navigation' })
    expect(navigation).toContain('data-[active]:[&_[data-slot=text]]:text-')
    expect(navigation).toContain('data-[active]:[&_[data-role=meta]]:text-')
    expect(navigation).toContain('data-[insert=before]:shadow-')
    expect(navigation).toContain('data-[insert=after]:shadow-')
    expect(navigation).toContain('data-[dragging]:opacity-40')
    expect(navigation).toContain('[&_[data-chevron][data-open]]:rotate-90')
  })

  it('owns borderless and default-cursor row postures without a feature override', () => {
    const markup = renderToStaticMarkup(
      <Button variant="row" bordered={false} cursor="default">History row</Button>,
    )
    expect(markup).toContain('border-0')
    expect(markup).toContain('cursor-default')
    expect(markup).toContain('select-none')
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

it('fills a swatch with the colour it offers and keeps it under the pointer', () => {
  const markup = renderToStaticMarkup(<Button variant="ghost" size="icon-circle" swatch="#e5484d" aria-label="Red" />)
  expect(markup).toContain('data-swatch')
  expect(markup).toContain('--swatch:#e5484d')
  expect(markup).toContain('bg-(--swatch)')
  expect(markup).toContain('hover:bg-(--swatch)')
  // Filled to its edge: the ring the chosen swatch wears sits outside it.
  expect(markup).toContain('bg-clip-border')

  const plain = renderToStaticMarkup(<Button variant="ghost" size="icon-circle" aria-label="Plain" />)
  expect(plain).not.toContain('data-swatch')
  expect(plain).not.toContain('--swatch')
})
