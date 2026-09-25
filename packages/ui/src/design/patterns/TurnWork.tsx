import type * as React from 'react'

import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { revealMotion } from '../ui/motion'
import { inkTone } from '../ui/tone'

/**
 * The anatomy of a turn's work in the transcript.
 *
 * A turn's work is a fold — "Worked for 1m 14s · read 6 files ›" — over the
 * steps it took, and while it runs, one faint line saying what is happening
 * this second. The parts only a turn's work has are here: the fold's control
 * and label, the rhythm every transcript item keeps in each register (the
 * transcript's items and a step group's both compose it), and the live line.
 * What the fold shares with every other disclosure — its chevron, the words
 * of its receipt — comes from the system's `DisclosureChevron` and `Text`.
 */

/** The fold control and label for one turn's work receipt. */
const TurnWorkHeader = ({
  trouble = false,
  className,
  ...props
}: React.ComponentProps<typeof Button> & { trouble?: boolean }) => (
  <Button
    data-slot="turn-work-header"
    {...(trouble ? { 'data-trouble': '' } : {})}
    quietHover
    className={className}
    {...props}
  />
)

/**
 * Where the turn stands, as the header's ink. A finished turn keeps the
 * row's own ink; a running one steps back to the neutral tone's secondary
 * tier, because the clock is ticking and is not yet the record; trouble is
 * the warning tone, and it survives the header's hover (`quietHover`). Both
 * are `inkTone`, the same inks `Text tone=` draws.
 */
type TurnWorkState = 'done' | 'running' | 'trouble'

/** "Worked for 1m 14s": figures in tabular digits, so a ticking clock does not jitter. */
const TurnWorkHeaderLabel = ({
  state = 'done',
  className,
  ...props
}: React.ComponentProps<'span'> & { state?: TurnWorkState }) => (
  <span
    data-slot="turn-work-header-label"
    data-state={state}
    className={cn(
      'shrink-0 tabular-nums',
      state === 'trouble' && inkTone({ tone: 'warning' }),
      state === 'running' && inkTone({ tone: 'neutral' }),
      className,
    )}
    {...props}
  />
)

/**
 * One transcript item's vertical rhythm. The ordinary register gives each
 * item 4px above and below; the light register — steps inside a turn's work
 * fold, where every step is a line rather than a card — gives it one.
 */
const TurnItem = ({
  register,
  className,
  ...props
}: React.ComponentProps<'div'> & { register?: 'light' }) => (
  <div
    data-slot="turn-item"
    className={cn(register === 'light' ? 'py-(--hd-space-px)' : 'py-(--hd-space-1)', className)}
    {...props}
  />
)

/**
 * The fold's open body: the steps themselves. Opening the fold reveals them in
 * place — they rise a step as they fade in (`revealMotion`), so the reader sees
 * where the list came from. Closing is instant; the fold is already gone.
 */
const TurnWorkBody = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="turn-work-body" className={cn(revealMotion, className)} {...props} />
)

/**
 * The live line: what is happening this second, in the register of a status
 * rather than a record — faint, and moving. It stands as tall as the step
 * rows it will become, and its words shimmer unless the reader asked for less
 * motion, when they are simply muted.
 *
 * It is a polite live region, and only its words are in it. Two options keep
 * that contract clean for a line that says more than an activity:
 *
 *   trail     a reading that ticks — a turn's clock — set after the words and
 *             outside the region, so a screen reader hears what is happening
 *             when it changes rather than once a second.
 *   settled   a line that is not motion but a state the thread is in — a wait,
 *             a stop — in the same box and ink, without the shimmer. It may
 *             lead with the glyph that says so (a `Dot`).
 */
const TurnWorkLive = ({
  className,
  children,
  trail,
  settled = false,
  ...props
}: React.ComponentProps<'div'> & { trail?: React.ReactNode; settled?: boolean }) => {
  const line = cn(
    'flex min-h-(--hd-control-h) items-center gap-(--hd-space-1-5) pt-0.5 pb-1 pl-0.5 text-base text-(--hd-muted-foreground)',
    className,
  )
  const words = settled ? (
    <span data-slot="turn-work-live-words" className="inline-flex items-center gap-(--hd-space-1-5)">
      {children}
    </span>
  ) : (
    <span
      data-slot="turn-work-live-words"
      className={cn(
        'bg-[linear-gradient(90deg,var(--hd-muted-foreground)_0%,var(--hd-muted-foreground)_35%,var(--hd-foreground)_50%,var(--hd-muted-foreground)_65%,var(--hd-muted-foreground)_100%)]',
        '[background-size:220%_100%] bg-clip-text text-transparent',
        'animate-[shimmer_var(--hd-duration-sweep)_linear_infinite] [--tw-enter-translate-x:0]',
        'motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-(--hd-muted-foreground)',
      )}
    >
      {children}
    </span>
  )
  const state = settled ? { 'data-settled': '' } : {}
  if (trail == null) {
    return (
      <div data-slot="turn-work-live" role="status" aria-live="polite" {...state} className={line} {...props}>
        {words}
      </div>
    )
  }
  return (
    <div {...state} className={line} {...props}>
      <span data-slot="turn-work-live" role="status" aria-live="polite" className="inline-flex min-w-0">
        {words}
      </span>
      <span data-slot="turn-work-live-trail" className="tabular-nums">
        {trail}
      </span>
    </div>
  )
}

export {
  TurnItem,
  TurnWorkBody,
  TurnWorkHeader,
  TurnWorkHeaderLabel,
  TurnWorkLive,
  type TurnWorkState,
}
