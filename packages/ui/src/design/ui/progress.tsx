import type * as React from 'react'

import { cn } from '@/lib/utils'
import { dotTint, dotTone, type Tint, type Tone } from './tone'
import styles from './progress.module.css'

/**
 * How far along something is.
 *
 * Deliberately a bar and a number, not a bar alone. A track filled to somewhere
 * around two-thirds is not a reading — the reader who needs to know whether a
 * budget is at 66% or 71% cannot get it off the pixels, and the one who does not
 * need the figure loses nothing by its being there.
 *
 * Direction is explicit. Ordinary progress fills with what has happened;
 * `measure="remaining"` fills with the value left, owns the warning and danger
 * thresholds, and labels that same value. The component never quietly inverts
 * one number while announcing another.
 */

type ProgressProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  /** Where the fill reaches, out of `max`. Clamped. */
  value: number | null
  max?: number
  /** The reading, shown after the track. `false` hides it. */
  label?: React.ReactNode | false
  /** The verdict the fill carries; `neutral` is the default and is not a verdict. */
  tone?: Tone
  size?: 'xs' | 'sm' | 'default'
  /** A remaining budget fills with what is left and owns its warning thresholds. */
  measure?: 'complete' | 'remaining'
  warningAt?: number
  dangerAt?: number
}

const Progress = ({
  className,
  value,
  max = 100,
  label,
  tone = 'neutral',
  size = 'default',
  measure = 'complete',
  warningAt = 20,
  dangerAt = 0,
  ...props
}: ProgressProps) => {
  /* One normalisation, used by the fill and by the announcement alike. A bar
     that draws 100% while announcing "150 of 100" is worse than one that does
     not announce at all: a sighted reader sees a full bar, a screen-reader
     user hears an impossible number, and only one of them can tell something
     is wrong. `max` is floored at 1 for the same reason &mdash; `aria-valuemax`
     of 0 is invalid and browsers report the whole widget as broken. */
  const safeMax = max > 0 ? max : 1
  const known = value !== null && Number.isFinite(value)
  const safeValue = known ? value : 0
  const share = Math.min(1, Math.max(0, safeValue / safeMax))
  const percent = Math.round(share * 100)
  const announced = Math.min(safeMax, Math.max(0, safeValue))
  const reading = label === false ? null : (label ?? (known ? `${percent}%` : 'Unknown'))
  const resolvedTone =
    measure === 'remaining' && known
      ? announced <= dangerAt
        ? 'danger'
        : announced < warningAt
          ? 'warning'
          : tone
      : tone

  return (
    <div
      data-slot="progress"
      data-measure={measure}
      data-tone={resolvedTone}
      {...(!known ? { 'data-unknown': '' } : {})}
      className={cn('flex items-center gap-2', className)}
      role="progressbar"
      {...(known ? { 'aria-valuenow': announced } : { 'aria-valuetext': 'not reported' })}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      {...props}
    >
      <div
        data-slot="progress-track"
        {...(measure === 'remaining' && known && announced <= dangerAt ? { 'data-empty': '' } : {})}
        className={cn(
          'relative min-w-0 flex-1 overflow-hidden rounded-full bg-(--hd-muted)',
          size === 'xs' || size === 'sm' ? 'h-1' : 'h-1.5',
          measure === 'remaining' && known && announced <= dangerAt && 'bg-(--hd-danger-dim)',
          !known && 'border border-dashed border-(--hd-border) bg-transparent opacity-50',
        )}
      >
        <div
          data-slot="progress-fill"
          /* `tone="neutral"` draws the foreground, not the grey the track is
             already painted in: a fill the same colour as its track reports
             nothing. Only a stated verdict reaches for a state colour. */
          className={cn(
            'h-full rounded-full transition-[width] duration-(--hd-duration) ease-(--hd-ease)',
            resolvedTone === 'neutral' ? 'bg-(--hd-muted-foreground)' : dotTone({ tone: resolvedTone }),
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

type ProgressRingProps = Omit<React.ComponentProps<'span'>, 'children'> & {
  value: number | null
  max?: number
  size: number
  tone?: Tone
  label?: string
}

const ProgressRing = ({
  value,
  max = 100,
  size,
  tone = 'brand',
  label,
  className,
  style,
  ...props
}: ProgressRingProps) => {
  const known = value !== null && Number.isFinite(value)
  const safeMax = max > 0 ? max : 1
  const announced = known ? Math.min(safeMax, Math.max(0, value)) : 0
  const percent = (announced / safeMax) * 100
  const ringStyle = {
    '--progress-ring-size': `${size}px`,
    '--progress-ring-stroke': `${Math.max(2, Math.round(size / 8))}px`,
    '--progress-ring-fill': `${percent}%`,
    ...style,
  } as React.CSSProperties
  return (
    <span
      data-slot="progress-ring"
      data-tone={tone}
      {...(!known ? { 'data-unknown': '' } : {})}
      className={cn(styles.ring, className)}
      style={ringStyle}
      {...(label
        ? {
            role: 'progressbar',
            'aria-label': label,
            ...(known ? { 'aria-valuenow': announced, 'aria-valuemin': 0, 'aria-valuemax': safeMax } : { 'aria-valuetext': 'not reported' }),
          }
        : { 'aria-hidden': true })}
      {...props}
    />
  )
}

/**
 * One share of the whole. Without a colour of its own, a part takes the next
 * step of the brand ramp, which is right when the parts are "more of the same
 * thing" (what is in context). A part that names a *kind* — which of nine
 * sorts of step the time went to — takes that kind's `tint` or `tone`, the
 * same pair `SeriesDot` takes, so the bar and its key cannot disagree.
 */
type ProgressStackPart = {
  id: string
  value: number
  label?: React.ReactNode
  detail?: React.ReactNode
  reading?: React.ReactNode
  meta?: React.ReactNode
  tint?: Tint
  tone?: Tone
}

const stackFill = (part: ProgressStackPart): string | undefined =>
  part.tone ? dotTone({ tone: part.tone }) : part.tint ? dotTint({ tint: part.tint }) : undefined

type ProgressStackProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  label: string
  parts: readonly ProgressStackPart[]
}

const ProgressStack = ({ label, parts, className, ...props }: ProgressStackProps) => (
  <div data-slot="progress-stack" role="img" aria-label={label} className={cn('flex flex-col', className)} {...props}>
    <div className="mx-2 mb-2 mt-0.5 flex h-1.5 gap-0.5 overflow-hidden rounded-(--hd-radius-xs)" aria-hidden>
      {parts.map((part, index) => (
        <span
          key={part.id}
          data-slot="progress-stack-part"
          {...(stackFill(part) ? {} : { 'data-part': index % 4 })}
          className={cn('h-full rounded-(--hd-radius-2xs) transition-[width] duration-(--hd-duration) ease-(--hd-ease)', stackFill(part) ?? styles.stackPart)}
          style={{ width: `${Math.max(1, part.value)}%` }}
        />
      ))}
    </div>
    {parts.some((part) => part.label != null) && (
      <div className="flex flex-col">
        {parts.map((part, index) => (
          <div key={part.id} data-slot="progress-stack-row" className="flex items-baseline gap-2 px-2 py-1 text-sm leading-(--hd-line-sm)">
            <span aria-hidden {...(stackFill(part) ? {} : { 'data-part': index % 4 })} className={cn('size-2 shrink-0 self-center rounded-(--hd-radius-2xs)', stackFill(part) ?? styles.stackSwatch)} />
            <span className="min-w-0 flex-1 text-(--hd-secondary-foreground)">
              {part.label}
              {part.detail != null && <span className="text-(--hd-muted-foreground) tabular-nums"> {part.detail}</span>}
            </span>
            {part.reading != null && <span className="shrink-0 text-(--hd-foreground) tabular-nums">{part.reading}</span>}
            {part.meta != null && <span className="min-w-16 shrink-0 text-right text-(--hd-muted-foreground) tabular-nums">{part.meta}</span>}
          </div>
        ))}
      </div>
    )}
  </div>
)

export { Progress, ProgressRing, ProgressStack, type ProgressProps, type ProgressStackPart }
