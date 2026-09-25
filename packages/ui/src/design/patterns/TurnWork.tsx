import type * as React from 'react'

import { ChevronIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'

/**
 * The anatomy of a turn's work in the transcript.
 *
 * A turn's work is a fold — "Worked for 1m 14s · read 6 files ›" — over the
 * steps it took, and while it runs, one faint line saying what is happening
 * this second. Every part of that has one drawing here: the fold's label and
 * the receipt beside it, its chevron, the step rows' rhythm in each register,
 * the body a burst of templated steps opens into, and the live line. The
 * screens (`TurnWork`, `StepGroup`, and the transcript's items) arrange them
 * and decide nothing about type, ink or padding.
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
 * row's own ink; a running one steps back to the secondary tier, because the
 * clock is ticking and is not yet the record; trouble is the warning ink, and
 * it survives the header's hover (`quietHover`).
 */
type TurnWorkState = 'done' | 'running' | 'trouble'

const TURN_WORK_INK: Record<TurnWorkState, string | undefined> = {
  done: undefined,
  running: 'text-(--hd-secondary-foreground)',
  trouble: 'text-(--hd-warning-ink)',
}

/** "Worked for 1m 14s": figures in tabular digits, so a ticking clock does not jitter. */
const TurnWorkHeaderLabel = ({
  state = 'done',
  className,
  ...props
}: React.ComponentProps<'span'> & { state?: TurnWorkState }) => (
  <span
    data-slot="turn-work-header-label"
    data-state={state}
    className={cn('shrink-0 tabular-nums', TURN_WORK_INK[state], className)}
    {...props}
  />
)

const RECEIPT_INK = {
  neutral: 'text-(--hd-muted-foreground)',
  warning: 'text-(--hd-warning-ink)',
  danger: 'text-(--hd-danger-ink)',
} as const

/**
 * What a folded turn amounted to, on the header's line: "· read 6 files",
 * "· 1 declined", "· 2 failed". Muted when it is a tally; a declined step is a
 * warning and a failed one a danger, so trouble stays visible while folded.
 */
const TurnWorkReceipt = ({
  tone = 'neutral',
  className,
  ...props
}: React.ComponentProps<'span'> & { tone?: keyof typeof RECEIPT_INK }) => (
  <span data-slot="turn-work-receipt" data-tone={tone} className={cn(RECEIPT_INK[tone], className)} {...props} />
)

/** The fold's chevron: muted, or the warning ink when the turn is in trouble. */
const TurnWorkChevron = ({
  open,
  trouble = false,
  className,
}: {
  open: boolean
  trouble?: boolean
  className?: string
}) => (
  <ChevronIcon
    data-slot="turn-work-chevron"
    className={cn(trouble ? 'text-(--hd-warning-ink)' : 'text-(--hd-muted-foreground)', className)}
    size={13}
    {...(open ? { 'data-open': '' } : {})}
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
 * What a burst of templated steps opens into. In the light register the
 * steps hang under the fold's summary, indented to its words; in the ordinary
 * one they sit in the card below a rule. The items inside give up their own
 * column width and rhythm, because the body already owns both.
 */
const StepFoldBody = ({
  register,
  className,
  ...props
}: React.ComponentProps<'div'> & { register?: 'light' }) => (
  <div
    data-slot="step-fold-body"
    className={cn(
      'flex flex-col [&>div]:max-w-none [&>div]:py-0',
      register === 'light'
        ? 'pl-(--hd-space-5) pb-(--hd-space-0-5) border-t-0 gap-(--hd-space-px)'
        : 'pt-(--hd-space-0-5) px-(--hd-space-2) pb-(--hd-space-2) border-t border-(--hd-border) gap-(--hd-space-1)',
      className,
    )}
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
  StepFoldBody,
  TurnItem,
  TurnWorkChevron,
  TurnWorkHeader,
  TurnWorkHeaderLabel,
  TurnWorkLive,
  TurnWorkReceipt,
  type TurnWorkState,
}
