import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'
import { softTone, type Tone } from './tone'

/**
 * One figure, and everything the reader needs to trust it.
 *
 * A number on a dashboard is useless without three things around it: what it
 * counts, what period it covers, and which way it is moving. Templates
 * routinely ship the first and third and drop the second, which produces the
 * classic unreadable tile — a big confident `$63,489` that could be today,
 * this month, or all time. `caption` is therefore not decoration; it is the
 * part that makes the number mean anything, and it sits directly under the
 * figure where the eye lands after reading it.
 *
 * Three variants, and they are three different claims about importance rather
 * than three looks:
 *
 *   plain      a figure among others inside a card that already has a header.
 *   bordered   a figure that is its own object on the page. The default.
 *   tinted     a figure whose *tone is the message* — four counts across the
 *              top of a queue, where "4 failed" needs to be red before it is
 *              read. Use it for a set, never for one tile on its own: a single
 *              coloured block among white ones reads as an alert.
 *
 * The tone reaches the ground only in `tinted`. Everywhere else it colours the
 * icon and nothing else, because a green border around a figure is a claim
 * nobody can interpret.
 */

const statVariants = cva('flex gap-3', {
  variants: {
    variant: {
      plain: 'p-0',
      bordered:
        'rounded-(--hd-radius) border border-(--hd-border) bg-(--hd-card) p-4 shadow-(--hd-shadow-sm)',
      tinted: 'rounded-(--hd-radius) p-4',
    },
    align: {
      start: 'flex-col items-start text-left',
      center: 'flex-col items-center text-center',
    },
  },
  defaultVariants: { variant: 'bordered', align: 'start' },
})

type StatProps = Omit<React.ComponentProps<'div'>, 'children'> &
  VariantProps<typeof statVariants> & {
    /** What the figure counts. Always present. */
    label: React.ReactNode
    /** The figure itself, formatted by the caller. */
    value: React.ReactNode
    /** The period or basis. Earned, not optional decoration — see above. */
    caption?: React.ReactNode
    /** Usually a `<Delta>`; anything that qualifies the figure. */
    trend?: React.ReactNode
    /** A glyph. Framed for you — pass the icon, not an `IconTile`. */
    icon?: React.ReactNode
    /** In `tinted`, the ground. Elsewhere, the icon's frame. */
    tone?: Tone
  }

const Stat = ({
  className,
  variant,
  align,
  label,
  value,
  caption,
  trend,
  icon,
  tone = 'neutral',
  ...props
}: StatProps) => (
  <div
    data-slot="stat"
    data-variant={variant ?? 'bordered'}
    className={cn(statVariants({ variant, align }), variant === 'tinted' && softTone({ tone }), className)}
    {...props}
  >
    <div className={cn('flex w-full items-start gap-3', align === 'center' && 'flex-col items-center')}>
      <div className="min-w-0 flex-1">
        {/* Label above value: the reader knows what they are looking at before
            they look at it, and the figure is the thing the eye stops on. */}
        <div
          className={cn(
            'text-xs font-medium',
            variant === 'tinted' ? 'opacity-80' : 'text-(--hd-muted-foreground)',
          )}
        >
          {label}
        </div>
        <div className="mt-1 text-xl leading-tight font-semibold tabular-nums">{value}</div>
      </div>
      {icon != null && (
        <span
          aria-hidden
          className={cn(
            'inline-flex size-8 shrink-0 items-center justify-center rounded-full [&_svg]:size-4',
            /* In a tinted tile the ground already carries the tone, so the
               glyph borrows the ink it is sitting in rather than stacking a
               second fill on top of the first. */
            variant === 'tinted' ? 'bg-(--hd-card)/40' : softTone({ tone }),
          )}
        >
          {icon}
        </span>
      )}
    </div>
    {(caption != null || trend != null) && (
      <div className="flex w-full flex-wrap items-center gap-2">
        {trend}
        {caption != null && (
          <span
            className={cn(
              'text-xs',
              variant === 'tinted' ? 'opacity-70' : 'text-(--hd-muted-foreground)',
            )}
          >
            {caption}
          </span>
        )}
      </div>
    )}
  </div>
)

/**
 * A row of figures that stays a row.
 *
 * `auto-fit` rather than a fixed column count, so the same markup gives four
 * across a desk window, two on a split pane and one in a sidebar without a
 * breakpoint being written at the call site.
 */
const StatRow = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="stat-row"
    className={cn('grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]', className)}
    {...props}
  />
)

export { Stat, StatRow, statVariants }
