import type * as React from 'react'

import { cn } from '@/lib/utils'
import { dotTone, type Tone } from './tone'

/**
 * How far along something is.
 *
 * Deliberately a bar and a number, not a bar alone. A track filled to somewhere
 * around two-thirds is not a reading — the reader who needs to know whether a
 * budget is at 66% or 71% cannot get it off the pixels, and the one who does not
 * need the figure loses nothing by its being there.
 *
 * One rule this component holds, learned the hard way in this app's usage
 * meters: **it fills with what has happened**. A bar that filled with what was
 * *left* sat beside a number counting up and the two contradicted each other on
 * the same line. If a surface wants a remaining-budget reading, it passes the
 * remaining value and labels it as such; the bar does not quietly invert.
 */

type ProgressProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  /** Where the fill reaches, out of `max`. Clamped. */
  value: number
  max?: number
  /** The reading, shown after the track. `false` hides it. */
  label?: React.ReactNode | false
  /** The verdict the fill carries; `neutral` is the default and is not a verdict. */
  tone?: Tone
  size?: 'sm' | 'default'
}

const Progress = ({
  className,
  value,
  max = 100,
  label,
  tone = 'neutral',
  size = 'default',
  ...props
}: ProgressProps) => {
  /* One normalisation, used by the fill and by the announcement alike. A bar
     that draws 100% while announcing "150 of 100" is worse than one that does
     not announce at all: a sighted reader sees a full bar, a screen-reader
     user hears an impossible number, and only one of them can tell something
     is wrong. `max` is floored at 1 for the same reason &mdash; `aria-valuemax`
     of 0 is invalid and browsers report the whole widget as broken. */
  const safeMax = max > 0 ? max : 1
  const share = Math.min(1, Math.max(0, value / safeMax))
  const percent = Math.round(share * 100)
  const announced = Math.min(safeMax, Math.max(0, value))
  const reading = label === false ? null : (label ?? `${percent}%`)

  return (
    <div
      data-slot="progress"
      className={cn('flex items-center gap-2', className)}
      role="progressbar"
      aria-valuenow={announced}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      {...props}
    >
      <div
        className={cn(
          'relative min-w-0 flex-1 overflow-hidden rounded-full bg-(--hd-muted)',
          size === 'sm' ? 'h-1' : 'h-1.5',
        )}
      >
        <div
          data-slot="progress-fill"
          /* `tone="neutral"` draws the foreground, not the grey the track is
             already painted in: a fill the same colour as its track reports
             nothing. Only a stated verdict reaches for a state colour. */
          className={cn(
            'h-full rounded-full transition-[width] duration-(--hd-duration) ease-(--hd-ease)',
            tone === 'neutral' ? 'bg-(--hd-foreground)' : dotTone({ tone }),
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      {reading != null && (
        <span className="shrink-0 text-xs tabular-nums text-(--hd-muted-foreground)">{reading}</span>
      )}
    </div>
  )
}

export { Progress }
