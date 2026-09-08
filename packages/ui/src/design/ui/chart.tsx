import { useId, useState, type ReactNode, type KeyboardEvent } from 'react'
import type * as React from 'react'

import { cn } from '@/lib/utils'
import { dotTint, inkTone, softTone, type Tint, type Tone } from './tone'

/**
 * The card around the chart, and the four marks that go in it.
 *
 * `spark.tsx` holds charts small enough to live inside a sentence. This file
 * holds the other size: a figure that is the subject of its own panel, with a
 * header, a period control, an axis, a legend and a tooltip around it. The
 * survey behind this layer found that the surrounding card is most of the
 * work and almost none of the published examples — the free chart docs hand
 * you a bar on a blank canvas and leave the header stat, the delta badge, the
 * period tabs and the tooltip to be reinvented per screen. Reinvented per
 * screen is how an app ends up with three tooltips.
 *
 * Four marks, and each one answers a question the others answer badly:
 *
 *   SegmentMeter  what is left of one allowance. Segments rather than a
 *                 continuous bar because a countable meter reads as a budget
 *                 and a smooth one reads as a percentage — and the thing
 *                 being drawn is a budget.
 *   BurnDown      whether that allowance will last. The only mark here with
 *                 a *prediction* in it, which is why it carries the dashed
 *                 sustainable rate to be judged against.
 *   DayColumns    a quantity per day, split by whoever spent it.
 *   ChartKeys     which colour is which. Names only — where the figures are
 *                 worth having there is already a table carrying them.
 *
 * Everything takes plain numbers. The kit knows nothing about lanes, ledgers
 * or agents — the arithmetic lives in `lib/`, is tested without a browser, and
 * arrives here already decided, exactly as the rest of this layer works.
 *
 * Colour follows the rule the tone module sets. A series takes a `tint`,
 * because "which agent" identifies and does not judge; a meter takes a `tone`,
 * because "12% left" is a claim about condition. The two never swap.
 */

/* --- the frame ------------------------------------------------------------ */

/**
 * A chart's panel: a matted card.
 *
 * The outer element is a hairline border around a 2px gutter of the muted
 * ground, and the figure sits on the card colour inside it. That gutter is
 * the whole trick — it separates the chart's own ink from the page without a
 * second border, and it gives the header somewhere to sit that is visibly not
 * the plotting area. A plain card puts the title, the toolbar and the axis on
 * one continuous surface, and the reader has to work out where the data
 * starts.
 */
const ChartFrame = ({ className, ...props }: React.ComponentProps<'section'>) => (
  <section
    data-slot="chart-frame"
    className={cn(
      'rounded-(--hd-radius-lg) border border-(--hd-border) bg-(--hd-muted)/60 p-(--hd-space-0-5)',
      className,
    )}
    {...props}
  />
)

/**
 * The inner surface. Split from the frame so a card can hold two of them —
 * a stat band above a plot — separated by the gutter rather than by a rule.
 */
const ChartCard = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="chart-card"
    className={cn(
      'rounded-[calc(var(--hd-radius-lg)-var(--hd-space-0-5))] bg-(--hd-card) px-4 py-3',
      className,
    )}
    {...props}
  />
)

/** Title and hint on the left, controls on the right, on one baseline. */
const ChartHead = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="chart-head"
    className={cn('flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5', className)}
    {...props}
  />
)

const ChartTitle = ({ className, ...props }: React.ComponentProps<'h3'>) => (
  <h3
    data-slot="chart-title"
    className={cn('text-sm leading-tight font-semibold', className)}
    {...props}
  />
)

/**
 * The line under the title that says what the figure is measuring.
 *
 * Earned, not default — the same rule a list row's second line keeps. A chart
 * called "What it cost" over a column of dollars needs no hint; one whose
 * numbers are an estimate rather than a bill does.
 */
const ChartHint = ({ className, ...props }: React.ComponentProps<'p'>) => (
  <p
    data-slot="chart-hint"
    className={cn('text-(--hd-muted-foreground) mt-0.5 text-xs', className)}
    {...props}
  />
)

const ChartTools = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="chart-tools"
    className={cn('flex shrink-0 items-center gap-1.5', className)}
    {...props}
  />
)

/**
 * The one line under the plot: what the figures are worth, and at most one
 * thing to do about it.
 *
 * Prose, not chips. Four facts wearing chip borders read as a toolbar, and a
 * chip is a thing you can press.
 */
const ChartFoot = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="chart-foot"
    className={cn(
      'text-(--hd-muted-foreground) flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-2 text-xs',
      className,
    )}
    {...props}
  />
)

/** The x-axis: the ends named, and optionally where "now" falls between them. */
const ChartAxis = ({
  className,
  start,
  end,
  now,
  nowLabel = 'now',
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  start: ReactNode
  end: ReactNode
  /** Where "now" sits, 0..1. Omitted, or too near an end to fit, draws nothing. */
  now?: number
  nowLabel?: string
}) => {
  // The end labels are anchored to the ends, so a "now" close to either one
  // would print on top of it. Hiding it costs nothing: the marker on the plot
  // already says where now is, and this label only names it.
  const showNow = now !== undefined && now > 0.16 && now < 0.84
  return (
    <div
      data-slot="chart-axis"
      /* `text-xs`, not `text-(--hd-text-xs)`. Tailwind v4 reads a bare
         `text-(…)` as a *colour*, so the token form compiled to
         `color: var(--hd-text-xs)` — `color: 12px`, invalid, dropped — and
         tailwind-merge, seeing two classes in the colour group, threw the
         muted-foreground one away before the CSS was ever built. The axis
         had neither a size nor a colour and rendered at the inherited 14px
         in full-strength ink, which is also why the bold `now` label beside
         it had nothing to stand out from. The shadcn bridge maps `text-xs`
         onto the same 12px step, so this is the desk's own scale either way. */
      className={cn(
        'relative mt-1.5 flex items-center justify-between text-xs tabular-nums text-(--hd-muted-foreground)',
        className,
      )}
      {...props}
    >
      <span>{start}</span>
      {showNow && (
        <span
          className="text-(--hd-foreground) absolute -translate-x-1/2 font-medium"
          style={{ left: `${(now * 100).toFixed(2)}%` }}
        >
          {nowLabel}
        </span>
      )}
      <span>{end}</span>
    </div>
  )
}

/* --- the tooltip ---------------------------------------------------------- */

/**
 * A chart's own tooltip.
 *
 * Not the `title` attribute, which was what every chart in this app used
 * before: the browser's tooltip takes a second to appear, cannot be styled,
 * cannot hold two lines of figures, and never appears at all on a touch
 * surface or under a keyboard cursor. And not the hover-card primitive
 * either, which anchors to a trigger element — a chart's tip follows a
 * position inside the plot, so it is positioned by the plot.
 *
 * Rendered inside the plot's own relative box, clamped so a tip on the first
 * or last column stays inside the card.
 */
const ChartTip = ({
  className,
  at,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  /** Where the tip points, 0..1 across the plot. */
  at: number
}) => (
  <div
    data-slot="chart-tip"
    role="presentation"
    className={cn(
      'pointer-events-none absolute bottom-full z-10 mb-1.5 w-max max-w-56',
      'rounded-(--hd-radius-sm) border border-(--hd-border) bg-(--hd-popover) px-2 py-1.5',
      'text-(--hd-popover-foreground) shadow-(--hd-shadow) text-xs',
      className,
    )}
    /* One property owns the horizontal offset, and it is this one.
       Tailwind v4 implements `-translate-x-1/2` on the `translate` property
       rather than on `transform`, so an inline `style.translate` does not
       compose with the class — it replaces it. The pair used to be written as
       "centre with the class, nudge with the style", which meant every tip in
       the body of a chart lost its centring and sat with its left edge on the
       cursor, and a tip on the last column ran off the card entirely. */
    style={{ left: `${(at * 100).toFixed(2)}%`, translate: `${tipShift(at)}% 0` }}
    {...props}
  >
    {children}
  </div>
)

/**
 * How far to pull a tip back from the point it marks, as a share of its width.
 *
 * Centred (−50%) across the middle four-fifths of the plot, easing to 0% at
 * the very left and −100% at the very right so the tip stays inside the card
 * without ever jumping sides. Continuous at both hinges, which is what stops
 * it twitching as the cursor crosses them.
 */
const tipShift = (at: number): number => {
  if (at < 0.1) return -at * 500
  if (at > 0.9) return -100 + (1 - at) * 500
  return -50
}

/** One `label — value` line inside a tip. */
const ChartTipRow = ({
  label,
  value,
  tint,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  label: ReactNode
  value: ReactNode
  tint?: Tint
}) => (
  <div className={cn('flex items-center gap-1.5', className)} {...props}>
    {tint && <SeriesDot tint={tint} className="size-1.5" />}
    <span className="min-w-0 flex-1 truncate">{label}</span>
    <span className="shrink-0 font-medium tabular-nums">{value}</span>
  </div>
)

/* --- what is left --------------------------------------------------------- */

const meterFill: Record<Tone, string> = {
  neutral: 'bg-(--hd-muted-foreground)',
  brand: 'bg-(--hd-primary)',
  success: 'bg-(--hd-success)',
  warning: 'bg-(--hd-warning)',
  danger: 'bg-(--hd-danger)',
  info: 'bg-(--hd-tint-sky-ink)',
}

/**
 * One allowance, as a countable budget.
 *
 * Forty segments by default, which is CodexBar's capacity gauge and is the
 * right number for the job: enough that one segment is under three points, so
 * the meter never rounds a live figure to nothing, and few enough that a
 * reader can see it is a fixed quantity being spent rather than a proportion
 * being filled.
 *
 * **It fills with what is LEFT.** The whole app holds that rule — a bar that
 * fills as you spend contradicts the number beside it, which counts down —
 * and a component that could be pointed either way would eventually be
 * pointed both.
 *
 * `percent: null` is the honest empty state and is drawn as hollow segments,
 * never as zero: a source that gave a reset time but no figure has not said
 * the budget is gone.
 */
const SegmentMeter = ({
  className,
  percent,
  tone = 'neutral',
  segments = 40,
  label,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  /** What is left, 0..100. Null when the source reported no figure. */
  percent: number | null
  tone?: Tone
  segments?: number
  /** What this meter measures, for the accessibility tree. */
  label: string
}) => {
  const known = percent !== null && Number.isFinite(percent)
  const left = known ? Math.min(100, Math.max(0, percent)) : 0
  // Rounded up, so any live remainder lights at least one segment: a meter
  // that reads empty on an account that can still run a turn is the one
  // mistake this mark must not make.
  const lit = known ? Math.min(segments, Math.ceil((left / 100) * segments)) : 0
  return (
    <div
      data-slot="segment-meter"
      role="progressbar"
      aria-label={label}
      {...(known
        ? { 'aria-valuenow': Math.round(left), 'aria-valuemin': 0, 'aria-valuemax': 100 }
        : { 'aria-valuetext': 'not reported' })}
      className={cn('flex h-2.5 w-full items-stretch gap-px', className)}
      {...props}
    >
      {Array.from({ length: segments }, (_, index) => (
        <span
          key={index}
          className={cn(
            'min-w-px flex-1 transition-colors',
            index < lit
              ? meterFill[tone]
              : known
                ? 'bg-(--hd-border)'
                : /* Hollow rather than grey: "not reported" must not be able to
                     be misread as "nothing left". */
                  'border border-dashed border-(--hd-border) bg-transparent',
          )}
        />
      ))}
    </div>
  )
}

/* --- will it last --------------------------------------------------------- */

const burnInk: Record<Tone, string> = {
  neutral: 'var(--hd-foreground)',
  brand: 'var(--hd-primary)',
  success: 'var(--hd-success)',
  warning: 'var(--hd-warning)',
  danger: 'var(--hd-danger)',
  info: 'var(--hd-tint-sky-ink)',
}

/**
 * The burn-down: what is left against what an even burn would have left.
 *
 * Four lines, and the reading is in how they relate rather than in any one of
 * them:
 *
 *   the diagonal  full at the window's start, empty at its reset. Dashed and
 *                 knocked back, because it is a rate rather than a reading.
 *   the actual    solid, from full to where the account stands now.
 *   the projection fine-dotted, continuing the average burn to the reset or
 *                 to the floor, whichever comes first.
 *   the now dot   where the two meet, ringed in the card colour so it reads
 *                 on top of both.
 *
 * Above the diagonal is headroom; below it is borrowing. That is the entire
 * instruction, and it needs no legend — which is why this shape beats the
 * sentence it replaces, and why the projection is suppressed rather than
 * guessed when the window has barely opened.
 */
const BurnDown = ({
  className,
  elapsed,
  left,
  projectedAt,
  projectedLeft,
  forecast = true,
  tone = 'neutral',
  height = 84,
  label,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  /** Share of the window gone, 0..1. */
  elapsed: number
  /** Share of the allowance left, 0..100. */
  left: number
  /** Where the projection ends, 0..1. */
  projectedAt?: number
  projectedLeft?: number
  /** False while the window is too new to extrapolate: draws no projection. */
  forecast?: boolean
  tone?: Tone
  height?: number
  label: string
}) => {
  const gradient = useId()
  const ink = burnInk[tone]
  const W = 100
  const H = 100
  const x = (t: number): number => Math.min(W, Math.max(0, t * W))
  const y = (v: number): number => H - Math.min(H, Math.max(0, v)) * (H / 100)
  const nowX = x(elapsed)
  const nowY = y(left)

  return (
    <div
      data-slot="burn-down"
      className={cn('relative w-full', className)}
      style={{ height }}
      {...props}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        className="size-full overflow-visible"
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ink} stopOpacity="0.22" />
            <stop offset="100%" stopColor={ink} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* What has been spent so far, as volume under the actual line. */}
        <path
          d={`M0,${y(100)} L${nowX},${nowY} L${nowX},${H} L0,${H} Z`}
          fill={`url(#${gradient})`}
        />

        {/* The floor, so "empty" is a place on the chart rather than the edge
            of the box. */}
        <line
          x1="0"
          y1={H}
          x2={W}
          y2={H}
          stroke="var(--hd-border)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {/* Now, as a hairline the whole height, so the axis label under it has
            something to point at. */}
        <line
          x1={nowX}
          y1="0"
          x2={nowX}
          y2={H}
          stroke="var(--hd-border)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />

        {/* The sustainable rate. */}
        <line
          x1="0"
          y1={y(100)}
          x2={W}
          y2={y(0)}
          stroke="var(--hd-muted-foreground)"
          strokeOpacity="0.45"
          strokeWidth="1.25"
          strokeDasharray="3 3"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {forecast && projectedAt !== undefined && projectedLeft !== undefined && (
          <line
            x1={nowX}
            y1={nowY}
            x2={x(projectedAt)}
            y2={y(projectedLeft)}
            stroke={ink}
            strokeOpacity="0.75"
            strokeWidth="1.5"
            strokeDasharray="0.5 3.5"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}

        <path
          d={`M0,${y(100)} L${nowX},${nowY}`}
          fill="none"
          stroke={ink}
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* The dot is a DOM element rather than an SVG circle: the plot is
          stretched by `preserveAspectRatio="none"`, which would turn any
          circle in that coordinate system into an ellipse. */}
      <span
        aria-hidden
        className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-(--hd-card)"
        style={{
          left: `${nowX}%`,
          top: `${(nowY / H) * 100}%`,
          background: ink,
        }}
      />
    </div>
  )
}

/* --- a quantity per day --------------------------------------------------- */

export interface DaySeries {
  /** Stable identity — a runtime id, a model name. Decides the tint. */
  readonly key: string
  readonly label: string
  readonly tint: Tint
}

export interface DayBucket {
  /** The axis label for this column. */
  readonly label: string
  readonly total: number
  /** One value per entry of `series`, in the same order. */
  readonly parts: readonly number[]
}

/**
 * A column per bucket, split by series.
 *
 * The band this replaced summed every agent's spend into one grey column,
 * which threw away the fact the ledger goes to the trouble of recording: a
 * $40 Tuesday split three ways is a different Tuesday from a $40 Tuesday
 * spent entirely by one agent, and only the split one explains the ranked
 * table underneath.
 *
 * A day with nothing spent draws no column, only the floor. The chart this
 * replaced gave every empty day a 2px stub, so a fortnight of not working
 * read as a fortnight of small spending.
 *
 * Hover moves a cursor; ← and → move it from the keyboard, Home and End jump
 * to the ends, and Escape puts it away. The reading is announced politely for
 * a screen reader, and the whole series is also present as text, so the chart
 * is not the only copy of its own data.
 */
const DayColumns = ({
  className,
  buckets,
  series,
  format,
  height = 96,
  label,
  emptyLabel = 'Nothing spent',
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  buckets: readonly DayBucket[]
  series: readonly DaySeries[]
  /** How a value is written — the caller owns currency and rounding. */
  format: (value: number) => string
  height?: number
  label: string
  emptyLabel?: string
}) => {
  const [active, setActive] = useState<number | null>(null)
  const peak = buckets.reduce((high, bucket) => Math.max(high, bucket.total), 0)
  const shown = active !== null && active >= 0 && active < buckets.length ? buckets[active] : null
  const at = buckets.length > 1 && active !== null ? (active + 0.5) / buckets.length : 0.5

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (buckets.length === 0) return
    const last = buckets.length - 1
    // Every move reads the cursor out of the setter rather than out of the
    // render's closure. Held arrow keys arrive faster than React re-renders,
    // and a stale closure turns "walk the month" into "jump to day one, over
    // and over".
    const move = (step: (from: number | null) => number): void => {
      event.preventDefault()
      setActive((from) => Math.min(last, Math.max(0, step(from))))
    }
    if (event.key === 'ArrowRight') move((from) => (from === null ? 0 : from + 1))
    else if (event.key === 'ArrowLeft') move((from) => (from === null ? last : from - 1))
    else if (event.key === 'Home') move(() => 0)
    else if (event.key === 'End') move(() => last)
    else if (event.key === 'Escape' && active !== null) {
      event.preventDefault()
      /* And stop it there. The screen this kit is used on closes itself on a
         document-level Escape, so without this, putting the cursor away also
         shut the whole Dashboard — the one key a reader presses to undo
         something did two things, and the bigger one won. Only swallowed when
         there is a cursor to dismiss: an Escape on a chart with no cursor is
         the screen's to answer. */
      event.stopPropagation()
      setActive(null)
    }
  }

  return (
    <div data-slot="day-columns" className={cn('relative', className)} {...props}>
      {shown && (
        <ChartTip at={at}>
          <div className="mb-1 font-medium">{shown.label}</div>
          {shown.total <= 0 ? (
            <div className="text-(--hd-muted-foreground)">{emptyLabel}</div>
          ) : (
            <>
              {series.map((entry, index) => {
                const value = shown.parts[index] ?? 0
                if (value <= 0) return null
                return (
                  <ChartTipRow
                    key={entry.key}
                    tint={entry.tint}
                    label={entry.label}
                    value={format(value)}
                  />
                )
              })}
              {series.length > 1 && (
                <ChartTipRow
                  className="border-(--hd-border) mt-1 border-t pt-1"
                  label="Total"
                  value={format(shown.total)}
                />
              )}
            </>
          )}
        </ChartTip>
      )}

      <div
        role="group"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className="border-(--hd-border) flex items-end gap-px border-b"
        style={{ height }}
      >
        {buckets.map((bucket, index) => {
          /* The segments are shares of what is actually drawn, not of the
             bucket's arithmetic total. Only positive parts get a segment, so
             dividing by `total` is right until a row arrives negative — a
             credit, a correction — and then the drawn parts do not sum to
             their own column and one of them gets a negative height. Deriving
             the denominator from the same parts that are drawn makes the
             column self-consistent whatever the ledger says. */
          const drawn = series.map((_, part) => Math.max(0, bucket.parts[part] ?? 0))
          const drawnTotal = drawn.reduce((sum, part) => sum + part, 0)
          return (
            <div
              key={index}
              aria-hidden
              onPointerEnter={() => setActive(index)}
              data-active={index === active ? '' : undefined}
              className="group/col flex h-full min-w-0 flex-1 cursor-default flex-col justify-end"
            >
              <div
                className={cn(
                  'flex w-full flex-col-reverse overflow-hidden rounded-t-[3px] transition-opacity',
                  active !== null && index !== active && 'opacity-45',
                )}
                style={{
                  height: peak > 0 ? `${Math.max(0, Math.min(100, (drawnTotal / peak) * 100))}%` : '0%',
                }}
              >
                {series.map((entry, part) => {
                  const value = drawn[part] ?? 0
                  if (value <= 0 || drawnTotal <= 0) return null
                  return (
                    <span
                      key={entry.key}
                      className={cn('w-full shrink-0', dotTint({ tint: entry.tint }))}
                      style={{ height: `${(value / drawnTotal) * 100}%` }}
                    />
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <span aria-live="polite" className="sr-only">
        {shown
          ? `${shown.label}: ${shown.total > 0 ? format(shown.total) : emptyLabel}`
          : ''}
      </span>
      <ul className="sr-only">
        {buckets.map((bucket, index) => (
          <li key={index}>{`${bucket.label}: ${bucket.total > 0 ? format(bucket.total) : emptyLabel}`}</li>
        ))}
      </ul>
    </div>
  )
}

/* --- which series is which ------------------------------------------------ */

/**
 * The mark that says "this one".
 *
 * Exported because the legend is rarely the only place a series is named: a
 * ranked table beside a doughnut is keyed by the same colours, and a screen
 * that draws its own dot for that has quietly forked the palette. One dot,
 * one size, one radius, everywhere a series appears.
 */
const SeriesDot = ({
  className,
  tint,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & { tint: Tint }) => (
  <span
    data-slot="series-dot"
    aria-hidden
    className={cn('inline-block size-2 shrink-0 rounded-full', dotTint({ tint }), className)}
    {...props}
  />
)

/**
 * The key under a chart: which colour is which, and nothing else.
 *
 * Deliberately without values. A legend that repeats the figures is a table
 * with worse alignment, and where those figures are worth having there is
 * always a real table on the same screen already carrying them — so this
 * strip does the one job the table cannot, which is to tie a colour to a
 * name. It wraps rather than scrolling: a key that runs off the edge has
 * hidden exactly the series the reader could not identify.
 */
const ChartKeys = ({ className, ...props }: React.ComponentProps<'ul'>) => (
  <ul
    data-slot="chart-keys"
    className={cn('mt-2 flex flex-wrap items-center gap-x-3 gap-y-1', className)}
    {...props}
  />
)

const ChartKey = ({
  className,
  tint,
  label,
  ...props
}: Omit<React.ComponentProps<'li'>, 'children'> & { tint: Tint; label: ReactNode }) => (
  <li
    data-slot="chart-key"
    className={cn('text-(--hd-muted-foreground) flex items-center gap-1.5 text-xs', className)}
    {...props}
  >
    <SeriesDot tint={tint} />
    {label}
  </li>
)

/* --- the verdict beside a figure ------------------------------------------ */

const GLYPH: Record<string, string> = {
  conserving: '▲',
  overPace: '▼',
  onPace: '●',
  fresh: '◆',
  spent: '■',
}

/**
 * A rate's verdict: the glyph, the signed margin, and the word.
 *
 * Distinct from `Delta` on purpose. `Delta` reports a *change* between two
 * readings and colours it by whether the change is welcome. This reports a
 * *standing* against an expected rate, where the sign has no inherent verdict
 * — burning fast is fine on a window you are about to stop using — so the
 * caller passes the tone and the pill states the position rather than judging
 * it.
 */
const PaceBadge = ({
  className,
  status,
  margin,
  tone = 'neutral',
  word,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & {
  status: keyof typeof GLYPH | string
  /** Points above (positive) or below (negative) the sustainable rate. */
  margin?: number | null
  tone?: Tone
  word: string
}) => (
  <span
    data-slot="pace-badge"
    data-status={status}
    className={cn(
      'inline-flex h-(--hd-chip-h) shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap tabular-nums',
      softTone({ tone }),
      className,
    )}
    {...props}
  >
    {/* Not sized down: the badge is already the type scale's smallest step,
        and an arbitrary size here would be one more number that a density or
        foundation change cannot reach. The glyphs are chosen to sit at that
        size — `Delta` takes the same approach with its arrows. */}
    <span aria-hidden className={cn('leading-none', inkTone({ tone }))}>
      {GLYPH[status] ?? '●'}
    </span>
    {margin != null && Number.isFinite(margin) && (
      <span>{`${margin >= 0 ? '+' : '−'}${Math.abs(Math.round(margin))}%`}</span>
    )}
    <span className="font-normal opacity-80">{word}</span>
  </span>
)

export {
  BurnDown,
  ChartAxis,
  ChartCard,
  ChartFoot,
  ChartFrame,
  ChartHead,
  ChartHint,
  ChartKey,
  ChartKeys,
  ChartTip,
  ChartTipRow,
  ChartTitle,
  ChartTools,
  DayColumns,
  PaceBadge,
  SegmentMeter,
  SeriesDot,
}
