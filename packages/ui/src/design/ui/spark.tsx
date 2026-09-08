import type * as React from 'react'
import { useId } from 'react'

import { cn } from '@/lib/utils'
import { type Tint, TINTS } from './tone'

/**
 * Charts small enough to live inside a sentence.
 *
 * Not a charting library and not trying to be one: no axes, no legend, no
 * tooltip, no dependency. The job is the one a full chart does badly — sitting
 * next to a figure and showing its shape, so `$63,489` gains "and it dipped in
 * March" without costing a second card.
 *
 * Three marks, and the choice between them is about what the numbers are:
 *
 *   Sparkline   a quantity over time. The area under it is optional and reads
 *               as volume; leave it off when two lines share the frame.
 *   Bars        a quantity per bucket, where the buckets are countable and the
 *               reader might care about one of them.
 *   Donut       parts of a whole, and only when there are few enough parts to
 *               tell apart — past five wedges this is a stacked bar wearing a
 *               costume.
 *
 * Everything is drawn with `vector-effect="non-scaling-stroke"` and a
 * `preserveAspectRatio` of none, so one chart component stretches to whatever
 * box the layout gives it without the stroke going with it.
 *
 * Colour comes from the tint scale, because a series identifies rather than
 * judges: a line is not green because things are going well.
 */

const path = (values: number[], width: number, height: number, pad: number) => {
  if (values.length === 0) return { line: '', area: '' }
  const low = Math.min(...values)
  const high = Math.max(...values)
  const span = high - low || 1
  const step = values.length > 1 ? width / (values.length - 1) : 0
  const points = values.map((value, index) => {
    const x = index * step
    const y = pad + (1 - (value - low) / span) * (height - pad * 2)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  return {
    line: `M${points.join('L')}`,
    area: `M0,${height} L${points.join('L')} L${width},${height} Z`,
  }
}

type SparklineProps = Omit<React.ComponentProps<'svg'>, 'values'> & {
  values: number[]
  tint?: Tint
  /** Fill the area under the line. Off when the frame holds more than one series. */
  area?: boolean
  height?: number
}

const Sparkline = ({
  className,
  values,
  tint = 'blue',
  area = true,
  height = 48,
  ...props
}: SparklineProps) => {
  const gradient = useId()
  const width = 100
  const shape = path(values, width, height, 2)
  const ink = `var(--hd-tint-${tint}-ink)`

  return (
    <svg
      data-slot="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      className={cn('w-full', className)}
      style={{ height }}
      {...props}
    >
      {area && (
        <>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ink} stopOpacity="0.25" />
              <stop offset="100%" stopColor={ink} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={shape.area} fill={`url(#${gradient})`} />
        </>
      )}
      <path
        d={shape.line}
        fill="none"
        stroke={ink}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

type BarsProps = Omit<React.ComponentProps<'div'>, 'values'> & {
  values: number[]
  labels?: string[]
  tint?: Tint
  height?: number
  /** Draw this bar in full colour and mute the rest — "the one you asked about". */
  highlight?: number
}

const Bars = ({
  className,
  values,
  labels,
  tint = 'blue',
  height = 64,
  highlight,
  ...props
}: BarsProps) => {
  const high = Math.max(...values, 1)
  return (
    /* Flex boxes rather than SVG rects: the bars then keep their radius and
       their gaps at any width, and a label can sit under one without a second
       coordinate system to reason about. */
    <div data-slot="bars" className={cn('flex flex-col gap-1', className)} {...props}>
      <div className="flex items-end gap-1" style={{ height }}>
        {values.map((value, index) => (
          <span
            key={index}
            title={labels?.[index]}
            className="min-w-0 flex-1 rounded-t-[3px]"
            style={{
              height: `${Math.max(2, (value / high) * 100)}%`,
              background:
                highlight == null || highlight === index
                  ? `var(--hd-tint-${tint}-ink)`
                  : `var(--hd-tint-${tint}-fill)`,
            }}
          />
        ))}
      </div>
      {labels && (
        <div className="flex gap-1 text-xs text-(--hd-muted-foreground)">
          {labels.map((label, index) => (
            <span key={index} className="min-w-0 flex-1 truncate text-center">
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

type DonutProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  slices: { label: string; value: number; tint?: Tint }[]
  size?: number
  /** What goes in the hole — usually the total the wedges add up to. */
  children?: React.ReactNode
}

const Donut = ({ className, slices, size = 120, children, ...props }: DonutProps) => {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1
  const radius = 42
  const circumference = 2 * Math.PI * radius
  let offset = 0

  return (
    <div
      data-slot="donut"
      className={cn('relative shrink-0', className)}
      style={{ width: size, height: size }}
      {...props}
    >
      <svg viewBox="0 0 100 100" className="size-full -rotate-90" role="img">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--hd-muted)" strokeWidth="12" />
        {slices.map((slice, index) => {
          const share = slice.value / total
          const dash = share * circumference
          const element = (
            <circle
              key={slice.label}
              cx="50"
              cy="50"
              r={radius}
              fill="none"
              stroke={`var(--hd-tint-${slice.tint ?? TINTS[index % TINTS.length]}-ink)`}
              strokeWidth="12"
              /* A gap of one degree between wedges so two adjacent slices of
                 similar value still read as two. */
              strokeDasharray={`${Math.max(0, dash - 1)} ${circumference - dash + 1}`}
              strokeDashoffset={-offset}
            >
              <title>{`${slice.label}: ${slice.value}`}</title>
            </circle>
          )
          offset += dash
          return element
        })}
      </svg>
      {children != null && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {children}
        </div>
      )}
    </div>
  )
}

export { Sparkline, Bars, Donut }
