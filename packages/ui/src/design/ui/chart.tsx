import { useId, useState, type ReactNode, type KeyboardEvent } from 'react'
import type * as React from 'react'

import { cn } from '@/lib/utils'
import { dotTint, dotTone, inkTone, softTone, type Tint, type Tone } from './tone'

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
      'rounded-(--hd-radius-matted) bg-(--hd-card) px-4 py-3',
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

const ChartTitle = ({
  className,
  figure,
  ...props
}: React.ComponentProps<'h3'> & {
  /**
   * The title *is* the figure being charted — a window's total, read at the
   * same step as the period tiles beside it — rather than a caption above
   * one. Same role as `Text`'s `metric` (`design/patterns/Settings.tsx`),
   * composed here so a screen never spells the scale out in a raw utility
   * of its own (`AGENTS.md` rule 10).
   */
  figure?: boolean
}) => (
  <h3
    data-slot="chart-title"
    className={cn(
      figure
        ? 'text-lg leading-none font-semibold tracking-[-0.015em] tabular-nums'
        : 'text-sm leading-(--hd-line-sm) font-medium',
      className,
    )}
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
 *
 * Without `at`, the tip is only the plate, and whoever draws it places it.
 * That is for a figure that is not a plot with columns: the conversation map
 * offers a message's first words beside whichever dash the pointer is
 * nearest, which is the same tip following a position — just down a rail
 * rather than across an axis. A tip inside a control — the map's is inside
 * the mark's button — is `as="span"`, because a button holds phrasing
 * content and a `<div>` in one is invalid markup.
 */
const ChartTip = ({
  className,
  at,
  as: Element = 'div',
  children,
  ...props
}: React.ComponentProps<'div'> & {
  /** Where the tip points, 0..1 across the plot. Omitted, the owner places the tip. */
  at?: number
  /** The element the tip is: a `span` where it sits inside a control. */
  as?: 'div' | 'span'
}) => (
  <Element
    data-slot="chart-tip"
    role="presentation"
    {...(at === undefined ? { 'data-placement': 'owner' } : {})}
    className={cn(
      at !== undefined && 'pointer-events-none absolute bottom-full z-10 mb-1.5 w-max max-w-56',
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
    {...(at !== undefined ? { style: { left: `${(at * 100).toFixed(2)}%`, translate: `${tipShift(at)}% 0` } } : {})}
    {...props}
  >
    {children}
  </Element>
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
  divider,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  label: ReactNode
  value: ReactNode
  tint?: Tint
  /** Set off from the rows above it — a tip's own "Total" line. */
  divider?: boolean
}) => (
  <div
    className={cn('flex items-center gap-1.5', divider && 'border-(--hd-border) mt-1 border-t pt-1', className)}
    {...props}
  >
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
  percent = null,
  tone = 'neutral',
  segments = 40,
  parts,
  label,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  /** What is left, 0..100. Null when the source reported no figure. Ignored when `parts` is given. */
  percent?: number | null
  tone?: Tone
  segments?: number
  /**
   * A **distribution** rather than a budget — one continuous bar split by
   * share and coloured per entry, for "which slice is biggest" rather than
   * "how much of a whole is left". Given this, the bar draws one filled span
   * per entry sized to `value`'s share of the total, ignores
   * `percent`/`tone`/`segments` entirely, and stops rounding up a live
   * remainder — a distribution has nothing to protect from reading empty.
   */
  parts?: readonly { key: string; tint: Tint; value: number }[]
  /** What this meter measures, for the accessibility tree. */
  label: string
}) => {
  if (parts) {
    const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0)
    return (
      <div
        data-slot="segment-meter"
        data-variant="distribution"
        role="img"
        aria-label={label}
        className={cn('flex h-2.5 w-full overflow-hidden rounded-full bg-(--hd-border)', className)}
        {...props}
      >
        {total > 0 &&
          parts.map((part) => {
            const share = Math.max(0, part.value) / total
            if (share <= 0) return null
            return (
              <span
                key={part.key}
                className={cn('h-full', dotTint({ tint: part.tint }))}
                style={{ width: `${share * 100}%` }}
              />
            )
          })}
      </div>
    )
  }
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
  /**
   * No record for this day at all — before the ledger's own coverage, or a
   * ledger with no history yet. Drawn hatched in both modes, never as an
   * empty, priced day: the old chart drew a day nobody had scanned exactly
   * like a day that was scanned and spent nothing, and a fortnight before an
   * agent was ever added read as a fortnight of quiet work.
   */
  readonly unknown?: boolean
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
  mode = 'bars',
  ghost,
  today,
  axisTicks,
  previousLabel = 'Previous',
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  buckets: readonly DayBucket[]
  series: readonly DaySeries[]
  /** How a value is written — the caller owns currency and rounding. */
  format: (value: number) => string
  height?: number
  label: string
  emptyLabel?: string
  /** Stacked columns split by series, or one area line for the whole period. */
  mode?: 'bars' | 'line'
  /**
   * The previous period's total, index-aligned to `buckets` — see
   * `lib/ledger.ts`'s `alignGhost`. Drawn as a dashed line in either mode,
   * never as a second solid series: it is a comparison, not a competing
   * reading of the same day.
   */
  ghost?: readonly (number | null)[]
  /**
   * Index of today's bucket. A dashed outline on the bar in `'bars'` mode; an
   * emphasised dot on the line in `'line'` mode.
   */
  today?: number
  /**
   * Three round numbers — `[0, mid, max]`, from `lib/ledger.ts`'s
   * `axisTicks` — drawn down the left as a y-axis. Omitted draws no axis and
   * scales every bar to the tallest bucket instead, which is what this mark
   * did before either mode had one.
   */
  axisTicks?: readonly [number, number, number]
  /** What the ghost line's tip row is called. */
  previousLabel?: string
}) => {
  const [active, setActive] = useState<number | null>(null)
  const gradientId = useId()
  const peak = buckets.reduce((high, bucket) => Math.max(high, bucket.total), 0)
  const ceiling = axisTicks ? axisTicks[2] : peak
  const shown = active !== null && active >= 0 && active < buckets.length ? buckets[active] : null
  const at = buckets.length > 1 && active !== null ? (active + 0.5) / buckets.length : 0.5
  const previousShown = active !== null ? (ghost?.[active] ?? null) : null

  // Line geometry — a run of contiguous known indices at a time, so an
  // "unknown" island breaks the path rather than being bridged by a straight
  // line that would say there was a reading in between.
  const count = buckets.length
  const plotX = (index: number): number => (count > 1 ? ((index + 0.5) / count) * 100 : 50)
  const plotY = (value: number): number =>
    ceiling > 0 ? 100 - Math.min(100, Math.max(0, (value / ceiling) * 100)) : 100
  const runsWhere = (known: (index: number) => boolean): number[][] => {
    const runs: number[][] = []
    let run: number[] = []
    for (let index = 0; index < count; index += 1) {
      if (known(index)) run.push(index)
      else if (run.length > 0) {
        runs.push(run)
        run = []
      }
    }
    if (run.length > 0) runs.push(run)
    return runs
  }
  const lineOf = (indices: readonly number[], valueAt: (index: number) => number): string => {
    if (indices.length === 1) {
      const index = indices[0] as number
      const point = `${plotX(index).toFixed(2)},${plotY(valueAt(index)).toFixed(2)}`
      // A single known day has no neighbour to draw a line to. `M` alone has
      // no length and paints nothing, so this closes the segment on itself —
      // the same zero-length, round-capped trick that draws today's dot.
      return `M${point}L${point}`
    }
    return indices
      .map((index, position) => `${position === 0 ? 'M' : 'L'}${plotX(index).toFixed(2)},${plotY(valueAt(index)).toFixed(2)}`)
      .join('')
  }
  const areaOf = (indices: readonly number[], valueAt: (index: number) => number): string => {
    if (indices.length === 0) return ''
    const first = indices[0] as number
    const last = indices[indices.length - 1] as number
    // Baseline up to the first point, the line itself (its own leading `M`
    // dropped for `L`), then back down to the baseline and closed.
    return `M${plotX(first).toFixed(2)},100L${lineOf(indices, valueAt).slice(1)}L${plotX(last).toFixed(2)},100Z`
  }
  const valueRuns = mode === 'line' ? runsWhere((index) => !buckets[index]?.unknown) : []
  const ghostRuns = ghost ? runsWhere((index) => !buckets[index]?.unknown && ghost[index] != null) : []
  const todayKnown = today !== undefined && today >= 0 && today < count && !buckets[today]?.unknown

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
      <div className="flex items-stretch gap-2">
        {axisTicks && (
          <div
            aria-hidden
            className="relative shrink-0 text-right text-xs text-(--hd-muted-foreground) tabular-nums"
            style={{ height }}
          >
            {/* A label is positioned by its own value below, so it carries no
                width of its own any more — this invisible copy, still in
                normal flow, is what reserves the gutter's width instead. */}
            <div aria-hidden className="invisible flex flex-col pb-px">
              <span>{format(axisTicks[2])}</span>
              <span>{format(axisTicks[1])}</span>
              <span>{format(axisTicks[0])}</span>
            </div>
            {axisTicks.map((value, index) => (
              <span
                key={index}
                className="absolute inset-x-0 -translate-y-1/2"
                style={{ top: `${plotY(value)}%` }}
              >
                {format(value)}
              </span>
            ))}
          </div>
        )}

        <div
          role="group"
          aria-label={label}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
          className="border-(--hd-border) relative flex min-w-0 flex-1 items-end gap-px border-b"
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
            const isToday = index === today
            return (
              <div
                key={index}
                aria-hidden
                onPointerEnter={() => setActive(index)}
                data-active={index === active ? '' : undefined}
                className="group/col flex h-full min-w-0 flex-1 cursor-default flex-col justify-end"
              >
                {bucket.unknown ? (
                  /* "No record yet", never an empty $0 gap — the same hatch
                     the calendar heatmap draws for a day before its own
                     coverage, so the two charts agree on what "unknown"
                     looks like. Full height: the point is that there is
                     nothing to scale, not a reading of zero. */
                  <span
                    className={cn(
                      'h-full w-full rounded-t-(--hd-radius-2xs) opacity-70',
                      isToday && 'outline outline-dashed outline-1 -outline-offset-1 outline-(--hd-muted-foreground)',
                    )}
                    style={{ background: 'var(--hd-chart-heat-not-scanned)' }}
                  />
                ) : (
                  mode === 'bars' && (
                    <div
                      className={cn(
                        'flex w-full flex-col-reverse overflow-hidden rounded-t-(--hd-radius-2xs) transition-opacity',
                        active !== null && index !== active && 'opacity-45',
                        isToday && 'outline outline-dashed outline-1 -outline-offset-1 outline-(--hd-foreground)',
                      )}
                      style={{
                        height: ceiling > 0 ? `${Math.max(0, Math.min(100, (drawnTotal / ceiling) * 100))}%` : '0%',
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
                  )
                )}
              </div>
            )
          })}

          {/* The line, its ghost, and today's endpoint — one overlay so
              neither has to fight the bar columns for a coordinate system.
              `pointer-events-none` keeps the columns underneath the ones
              that answer hover and the keyboard cursor. */}
          {(mode === 'line' || ghost) && (
            <svg
              aria-hidden
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="pointer-events-none absolute inset-0 size-full overflow-visible"
            >
              {mode === 'line' &&
                valueRuns.map((run, runIndex) => (
                  <g key={runIndex}>
                    <defs>
                      <linearGradient id={`${gradientId}-${runIndex}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--hd-accent)" stopOpacity="0.28" />
                        <stop offset="100%" stopColor="var(--hd-accent)" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path
                      d={areaOf(run, (i) => buckets[i]?.total ?? 0)}
                      fill={`url(#${gradientId}-${runIndex})`}
                    />
                    <path
                      d={lineOf(run, (i) => buckets[i]?.total ?? 0)}
                      fill="none"
                      stroke="var(--hd-accent)"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                ))}
              {ghost &&
                ghostRuns.map((run, runIndex) => (
                  <path
                    key={`ghost-${runIndex}`}
                    d={lineOf(run, (i) => ghost[i] ?? 0)}
                    fill="none"
                    stroke="var(--hd-muted-foreground)"
                    strokeWidth="1.25"
                    strokeDasharray="3 3"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              {/* The keyboard and hover cursor draws no mark of its own in
                  line mode — the bar columns underneath dim everywhere but
                  the active one, but a line has no columns to dim. Without
                  this neither a pointer nor a keyboard reader can tell which
                  day the tip beside it is for. */}
              {mode === 'line' && active !== null && (
                <>
                  <line
                    x1={plotX(active)}
                    x2={plotX(active)}
                    y1={0}
                    y2={100}
                    stroke="var(--hd-border)"
                    vectorEffect="non-scaling-stroke"
                  />
                  {!buckets[active]?.unknown && (
                    <path
                      d={`M${plotX(active).toFixed(2)},${plotY(buckets[active]?.total ?? 0).toFixed(2)}L${plotX(active).toFixed(2)},${plotY(buckets[active]?.total ?? 0).toFixed(2)}`}
                      stroke="var(--hd-accent)"
                      strokeWidth="4"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {ghost && ghost[active] != null && (
                    <path
                      d={`M${plotX(active).toFixed(2)},${plotY(ghost[active] as number).toFixed(2)}L${plotX(active).toFixed(2)},${plotY(ghost[active] as number).toFixed(2)}`}
                      stroke="var(--hd-muted-foreground)"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                </>
              )}
              {/* Today's own emphasised mark. A `<circle>` under
                  `preserveAspectRatio="none"` is stretched by whatever the x
                  and y axes are scaled by relative to each other — `r` has no
                  `vectorEffect` to protect it the way a stroke does — so this
                  is drawn as a zero-length, round-capped path instead, which
                  `vectorEffect="non-scaling-stroke"` keeps a true circle at a
                  fixed screen size whatever the plot's aspect ratio. Two
                  passes stand in for the fill-plus-ring the circle drew: a
                  wider card-coloured pass behind, a narrower accent one on
                  top. */}
              {mode === 'line' && todayKnown && (
                <>
                  <path
                    d={`M${plotX(today as number).toFixed(2)},${plotY(buckets[today as number]?.total ?? 0).toFixed(2)}L${plotX(today as number).toFixed(2)},${plotY(buckets[today as number]?.total ?? 0).toFixed(2)}`}
                    stroke="var(--hd-card)"
                    strokeWidth="6.5"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                  <path
                    d={`M${plotX(today as number).toFixed(2)},${plotY(buckets[today as number]?.total ?? 0).toFixed(2)}L${plotX(today as number).toFixed(2)},${plotY(buckets[today as number]?.total ?? 0).toFixed(2)}`}
                    stroke="var(--hd-accent)"
                    strokeWidth="4.5"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </>
              )}
            </svg>
          )}

          {/* Rendered inside the plot's own relative box — not the outer one,
              which also spans the y-axis gutter — so `at`, a fraction across
              the plot alone, lands the tip over its own column rather than
              shifted left by the gutter's width. */}
          {shown && (
            <ChartTip at={at}>
              <div className="mb-1 font-medium">{shown.label}</div>
              {shown.unknown ? (
                <div className="text-(--hd-muted-foreground)">No record yet</div>
              ) : shown.total <= 0 ? (
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
                      divider
                      label="Total"
                      value={format(shown.total)}
                    />
                  )}
                </>
              )}
              {/* The comparison the header figure already claims, repeated here so
                  a reader who stopped to look at one day gets the same "against
                  what" the total above the chart does. */}
              {previousShown != null && (
                <ChartTipRow
                  divider
                  label={previousLabel}
                  value={format(previousShown)}
                  className="text-(--hd-muted-foreground)"
                />
              )}
            </ChartTip>
          )}
        </div>
      </div>

      <span aria-live="polite" className="sr-only">
        {shown
          ? `${shown.label}: ${shown.unknown ? 'No record yet' : shown.total > 0 ? format(shown.total) : emptyLabel}`
          : ''}
      </span>
      <ul className="sr-only">
        {buckets.map((bucket, index) => (
          <li key={index}>
            {`${bucket.label}: ${bucket.unknown ? 'No record yet' : bucket.total > 0 ? format(bucket.total) : emptyLabel}`}
          </li>
        ))}
      </ul>
    </div>
  )
}

/* --- which series is which ------------------------------------------------ */

/**
 * A series' colour, as the one prop that says which vocabulary it is from.
 *
 * Most series identify — "which agent" — and take a `tint`. Some keys name a
 * kind that already carries a judgement or a role of its own: the person's
 * own messages are neutral, the agent's answer is the brand, an edit is a
 * success and an error is a danger. Those take a `tone`, and the type refuses
 * both at once, the way `IconTile` does.
 */
type SeriesColour = { tint: Tint; tone?: never } | { tone: Tone; tint?: never }

const seriesFill = ({ tint, tone }: { tint?: Tint; tone?: Tone }): string =>
  tone ? dotTone({ tone }) : dotTint({ tint: tint ?? 'blue' })

/**
 * The mark that says "this one".
 *
 * Exported because the legend is rarely the only place a series is named: a
 * ranked table beside a doughnut is keyed by the same colours, and a screen
 * that draws its own dot for that has quietly forked the palette. One dot,
 * one size, one radius, everywhere a series appears — the Usage table's rows
 * and the trajectory ledger's steps alike.
 */
const SeriesDot = ({
  className,
  tint,
  tone,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & SeriesColour) => (
  <span
    data-slot="series-dot"
    {...(tone ? { 'data-tone': tone } : { 'data-tint': tint })}
    aria-hidden
    className={cn('inline-block size-2 shrink-0 rounded-full', seriesFill({ tint, tone }), className)}
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
  tone,
  label,
  ...props
}: Omit<React.ComponentProps<'li'>, 'children'> & SeriesColour & { label: ReactNode }) => (
  <li
    data-slot="chart-key"
    className={cn('text-(--hd-muted-foreground) flex items-center gap-1.5 text-xs', className)}
    {...props}
  >
    {tone ? <SeriesDot tone={tone} /> : <SeriesDot tint={tint as Tint} />}
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
