import type * as React from 'react'

import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
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
 * The live line: what is happening this second, in the register of a status
 * rather than a record — faint, and moving. It stands as tall as the step
 * rows it will become, and its words shimmer unless the reader asked for less
 * motion, when they are simply muted.
 */
const TurnWorkLive = ({ className, children, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="turn-work-live"
    role="status"
    aria-live="polite"
    className={cn(
      'flex min-h-(--hd-control-h) items-center pt-0.5 pb-1 pl-0.5 text-base text-(--hd-muted-foreground)',
      className,
    )}
    {...props}
  >
    <span
      className={cn(
        'bg-[linear-gradient(90deg,var(--hd-muted-foreground)_0%,var(--hd-muted-foreground)_35%,var(--hd-foreground)_50%,var(--hd-muted-foreground)_65%,var(--hd-muted-foreground)_100%)]',
        '[background-size:220%_100%] bg-clip-text text-transparent',
        'animate-[shimmer_1.8s_linear_infinite] [--tw-enter-translate-x:0]',
        'motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-(--hd-muted-foreground)',
      )}
    >
      {children}
    </span>
  </div>
)

export {
  TurnItem,
  TurnWorkHeader,
  TurnWorkHeaderLabel,
  TurnWorkLive,
  type TurnWorkState,
}
