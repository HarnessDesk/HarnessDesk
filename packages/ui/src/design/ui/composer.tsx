import type * as React from 'react'

import { CrossIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'

/**
 * The box you type into, wherever you are typing.
 *
 * This is the shell `components/Composer.tsx` draws — a rounded layer-1 surface
 * with a hairline, a shadow that deepens on focus, the text on top and the
 * controls beneath. It matters because the composer stopped belonging to one
 * screen: the same box serves a private thread with one agent and a room with
 * five, and the moment those are two components they start to differ in the
 * small ways nobody notices until they are side by side. Which is exactly what
 * happened — the room's box had a *lighter* edge, a *shallower* shadow, tighter
 * text padding, an accent ring on focus the real one has never had, and a
 * rectangular Send where the conversation has a round accent coin.
 *
 * So every value here is copied from `components/Composer.module.css`, and
 * `composer.parity.test.ts` reads that file and fails if it moves without this
 * one. Two files, one shape, and the drift is caught rather than noticed.
 *
 * Presentation only, deliberately. It holds no draft, no queue, no attachments.
 * The app's Composer is the thing that knows about those and belongs inside
 * this; a screen that only needs somewhere to type — a mock, a preview, a room
 * whose transport is a channel rather than a turn — uses the shell alone.
 *
 * The focus treatment is `focus-within` on the shell rather than a ring on the
 * textarea, because the composer is one object to the reader: pressing the
 * attach button has not left the box. And it deepens the shadow rather than
 * lighting an accent ring — the box says it has your keystrokes; it is not
 * asking for attention.
 */

const ComposerShell = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="composer"
    className={cn(
      'flex flex-col rounded-(--hd-radius-lg) bg-(--hd-card)',
      'shadow-[0_1px_3px_rgba(0,0,0,0.06)] ring-1 ring-(--hdp-alias-border-l3) ring-inset',
      // The focused shadow carries `--hd-composer-ring` ahead of it, exactly as
      // the module does. Under Desk that token is `none` and this is one
      // shadow; under Studio it is the app's focus ring, and without it here
      // the two composers announced focus differently in the same interface —
      // one of them one keystroke from the other.
      'transition-shadow focus-within:shadow-[var(--hd-composer-ring,0_0_0_0_transparent),0_2px_10px_rgba(0,0,0,0.08)]',
      'focus-within:ring-(--hdp-alias-border-l4)',
      className,
    )}
    {...props}
  />
)

/**
 * The text.
 *
 * `field-sizing-content` grows the box with what is in it — the browser's own
 * answer, and the reason there is no resize observer here. `rows` sets the
 * floor. Bare of chrome because the shell wears it.
 *
 * `focus-visible:outline-none` and not merely `outline-none`: `app.css` is
 * bundled last and carries a global `:focus-visible { outline: 2px solid }`,
 * which beats a plain `outline-none` on specificity and drew a bright accent
 * rectangle around the text well while the shell was already saying, quietly,
 * that it had the keystrokes. Two focus indications, one of them wrong. The
 * module the app's own composer uses spells the same rule out for the same
 * reason.
 */
const ComposerText = ({ className, rows = 1, ...props }: React.ComponentProps<'textarea'>) => (
  <textarea
    data-slot="composer-text"
    rows={rows}
    className={cn(
      'field-sizing-content max-h-(--hd-composer-max) min-h-(--hd-composer-min) w-full resize-none bg-transparent px-3.5 pt-3.5 pb-1.5 text-base leading-(--hd-composer-line) outline-none focus-visible:outline-none placeholder:text-(--hd-muted-foreground)',
      className,
    )}
    {...props}
  />
)

/**
 * The row under the text: what this message will be, and how to send it.
 *
 * Left is context the message carries — which agent, which model, what is
 * attached. Right is the act. That order is not decorative: the reader sets up
 * on the left and commits on the right, and a send button that drifts left of a
 * model picker gets pressed before the model is chosen.
 */
const ComposerTools = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="composer-tools"
    className={cn('flex items-center gap-1.5 pt-1 pr-2 pb-2 pl-2.5', className)}
    {...props}
  />
)

/**
 * Send.
 *
 * The round ink coin the conversation's composer has always had — accent
 * until the token layer split ink from brand, and ink now, with every other
 * filled control. The room used a rectangular button with the word on it,
 * which is a different act to the eye — and the two boxes sit one keystroke
 * apart.
 *
 * `data-when="later"` is the second weight, and it turned out the channel needs
 * it after all. It was skipped here on the reasoning that a channel has no
 * turns — but its *receivers* do: a post to a member who is mid-turn is held
 * by the host and delivered when that turn ends, which is the same fact the
 * conversation's coin has always drawn. So the tint is the module's tint,
 * value for value, down to the 78% edge that keeps a tinted glyph legible in
 * both themes.
 */
const ComposerSend = ({ className, ...props }: React.ComponentProps<'button'>) => (
  <button
    type="button"
    data-slot="composer-send"
    className={cn(
      /* Resting is the ink, with every other filled control — and the glyph is
         the solid's own foreground, not `text-white`: in the dark theme the
         coin is near-white and a white arrow is not there.

         The queued weight below stays mixed from the **accent**, and that is
         a decision rather than an oversight. Three states have to be told
         apart at 30px: `nothing` is a flat grey plate, `later` is queued, and
         `now` is ink. Mixing `later` from the ink at 22% lands on a light
         grey — which is what `nothing` already is, and what a disabled
         control looks like everywhere else in the app. Worse, the coin that
         `later` appears *beside* is Stop, which is ink-filled: two greys of
         one hue, side by side, is the exact arrangement the Stop comment in
         Composer.module.css was written to prevent. A different hue is what
         makes "this will go when the turn ends" read as a state rather than
         as an unavailable button. */
      'inline-grid size-7.5 place-items-center rounded-full bg-(--hd-solid) text-(--hd-solid-foreground)',
      'transition-[background,transform] hover:bg-(--hd-solid-hover) active:scale-90',
      'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-(--hd-solid)',
      'data-[when=later]:bg-[color-mix(in_srgb,var(--hd-accent)_22%,transparent)]',
      'data-[when=later]:text-[color-mix(in_srgb,var(--hd-accent)_74%,var(--hdp-alias-label-primary))]',
      'data-[when=later]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--hd-accent)_78%,transparent)]',
      'data-[when=later]:hover:bg-[color-mix(in_srgb,var(--hd-accent)_32%,transparent)]',
      '[&_svg]:size-4',
      className,
    )}
    {...props}
  />
)

/** The gap that pushes the send side to the right. One per row. */
const ComposerGap = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="composer-gap" aria-hidden className={cn('flex-1', className)} {...props} />
)

/**
 * A thing the message will carry, shown above the text.
 *
 * An addressed agent, an attached file, a quoted turn. Removable, and it says
 * so with a real button rather than a hover-only ✕ — a chip whose removal is
 * invisible until the pointer arrives is a chip a keyboard cannot get rid of.
 */
const ComposerChip = ({
  className,
  onRemove,
  children,
  ...props
}: React.ComponentProps<'span'> & { onRemove?: () => void }) => (
  <span
    data-slot="composer-chip"
    className={cn(
      'inline-flex h-(--hd-chip-h) items-center gap-1 rounded-full bg-(--hd-muted) pl-2 text-xs',
      onRemove ? 'pr-0.5' : 'pr-2',
      className,
    )}
    {...props}
  >
    {children}
    {onRemove && (
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove"
        className="inline-flex size-4 items-center justify-center rounded-full text-(--hd-muted-foreground) hover:bg-(--hd-hover) hover:text-(--hd-foreground) [&_svg]:size-3"
      >
        <CrossIcon />
      </button>
    )}
  </span>
)

const ComposerChips = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="composer-chips"
    className={cn('flex flex-wrap items-center gap-1.5 px-3 pt-2.5', className)}
    {...props}
  />
)

export {
  ComposerShell,
  ComposerText,
  ComposerTools,
  ComposerGap,
  ComposerSend,
  ComposerChip,
  ComposerChips,
}
