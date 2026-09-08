import type * as React from 'react'

import { cn } from '@/lib/utils'
import { softTone, type Tone } from './tone'

/**
 * A change, with its sign said in colour as well as in punctuation.
 *
 * Every dashboard has this pill and most of them get it wrong in the same way:
 * the colour is chosen at the call site, so somewhere in the app a −3% is green
 * because the developer thought that row looked better that way. Here the sign
 * decides the tone and the call site cannot overrule it by accident.
 *
 * What the call site *can* say is `better`, and it has to when down is good.
 * Cost fell 12%, latency fell 40ms, the error rate halved: all improvements, all
 * negative numbers. `better="down"` flips which sign reads as success without
 * anyone hand-picking a colour, and the arrow keeps pointing the way the number
 * actually moved — which is the honest arrangement, because the arrow reports
 * the measurement and the colour reports the verdict.
 *
 * A zero is neither. It takes the neutral tone and no arrow, because a flat
 * week is not a small victory.
 *
 * The number is yours to format — `12%`, `1.2k`, `40ms`. The pill supplies the
 * sign, so pass the magnitude and let `value` carry direction.
 */

const ARROW = { up: '↑', down: '↓', flat: '' } as const

type DeltaProps = Omit<React.ComponentProps<'span'>, 'children'> & {
  /** Signed magnitude. Its sign chooses the direction; zero reads as flat. */
  value: number
  /** How to render the magnitude. Defaults to the number followed by `%`. */
  format?: (magnitude: number) => string
  /** Which direction is the good news. Defaults to up. */
  better?: 'up' | 'down'
  /** Say the arrow but not the verdict — for a change that is merely a fact. */
  tone?: Extract<Tone, 'neutral'>
  /** What the number is a change *from*, said after the pill. */
  caption?: React.ReactNode
}

const Delta = ({ className, value, format, better = 'up', tone, caption, ...props }: DeltaProps) => {
  const direction = value === 0 ? 'flat' : value > 0 ? 'up' : 'down'
  const verdict: Tone =
    tone ?? (direction === 'flat' ? 'neutral' : direction === better ? 'success' : 'danger')
  const text = (format ?? ((n: number) => `${n}%`))(Math.abs(value))

  return (
    <span data-slot="delta-line" className={cn('inline-flex items-baseline gap-1.5', className)}>
      <span
        data-slot="delta"
        data-direction={direction}
        className={cn(
          'inline-flex h-(--hd-chip-h) shrink-0 items-center gap-0.5 rounded-full px-1.5 text-xs font-medium whitespace-nowrap tabular-nums',
          softTone({ tone: verdict }),
        )}
        {...props}
      >
        {ARROW[direction] && <span aria-hidden>{ARROW[direction]}</span>}
        {text}
      </span>
      {caption != null && (
        <span className="text-(--hd-muted-foreground) text-xs">{caption}</span>
      )}
    </span>
  )
}

export { Delta }
