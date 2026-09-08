import type { UsageLane } from '@harnessdesk/protocol'

/**
 * Burn-down: whether a rolling window will last, as geometry rather than as a
 * sentence.
 *
 * The screen already knew all of this — `pace()` computed the delta, the
 * expected share and the run-out estimate, and then spent it on eight words
 * at the bottom of a card. Every one of those numbers is a coordinate, and
 * four of them together are a chart a reader can check at a glance: how much
 * is gone, how much *should* be gone, where the line is headed, and whether
 * it crosses the floor before the window refills.
 *
 * The model is CodexBar's burn-down widget, which is the prior art here and
 * got the shape right: one axis is the window, the other is what is left,
 * and the diagonal from full-at-the-start to empty-at-the-reset is the
 * sustainable rate. Above the diagonal is money in the bank; below it is
 * borrowing against the rest of the window.
 *
 * Two rules of this codebase change it. First, a lane whose usage the source
 * never reported has no geometry at all rather than a line at 100% — `null`,
 * not a full window. Second, one threshold governs everything a forecast
 * touches: below `FORECAST_NEEDS_ELAPSED` of the window the slope is a single
 * sample and extrapolating it says "runs dry in minutes" at 99% remaining, so
 * `forecast` is false and every caller withholds the projection, the estimate
 * and the verdict together. The geometry itself is still returned, because
 * the *shape* of a barely-opened window is not a lie — only the prediction is.
 */

const MINUTE = 60_000

/**
 * How much of the window has to be gone before the slope means anything.
 *
 * The same 5% `pace()` has always used, kept as one constant rather than two,
 * so the chart's projection and the sentence under it can never disagree
 * about whether there is anything to say.
 */
export const FORECAST_NEEDS_ELAPSED = 0.05

/**
 * How far off the sustainable rate counts as off it.
 *
 * Two points, which is the band `pace()` was already tested against. Wider
 * bands (CodexBar uses four) call more windows "on pace"; this one is ours
 * and the arithmetic is the same either way.
 */
export const MARGIN_BAND = 2

/**
 * What the burn says about itself, in the word the badge wears.
 *
 * `fresh` and `spent` are edge states rather than verdicts: at 100% and at 0%
 * the margin is arithmetically true and completely uninteresting, so the
 * badge says the state and drops the number.
 */
export type BurnStatus = 'fresh' | 'conserving' | 'onPace' | 'overPace' | 'spent'

export interface BurnView {
  /** Share of the window gone, 0..1. Clamped off both ends so a line is drawable. */
  readonly elapsed: number
  /** Share of the allowance left, 0..100. */
  readonly left: number
  /** What an even burn would have left by now, 0..100. */
  readonly ideal: number
  /**
   * `left − ideal`, in points. Positive is money in the bank, which is the
   * sign that matches the picture: the actual line sits *above* the diagonal.
   */
  readonly margin: number
  /** Points of allowance per unit of window. Negative while burning. */
  readonly slope: number
  /** Where the projection ends — the reset, or the moment it hits the floor. */
  readonly projectedAt: number
  readonly projectedLeft: number
  /** True when the projection reaches zero before the window refills. */
  readonly runsOut: boolean
  readonly status: BurnStatus
  /**
   * False while the window has barely opened. Every caller gates the
   * projection, the estimate and the verdict on it — see the note above.
   */
  readonly forecast: boolean
  /** Milliseconds until it is spent, when that lands before the reset. */
  readonly etaMs: number | null
  readonly windowMs: number
  /** Epoch milliseconds. `startsAt` is derived: a window has one length. */
  readonly startsAt: number
  readonly resetsAt: number
}

/**
 * The geometry of one lane's window, or null when there is no window to draw.
 *
 * Null for the four cases where any line would be invented: a source that
 * gave no usage figure, no reset, no window length, or a reset further away
 * than a whole window — the last of which means the source is describing a
 * window we are not inside, and anchoring a chart to it would put "now"
 * outside its own axis.
 */
export const burn = (lane: UsageLane, now: number): BurnView | null => {
  if (lane.usageKnown === false) return null
  if (lane.resetsAt === null) return null
  if (lane.windowMinutes === null || lane.windowMinutes <= 0) return null

  const windowMs = lane.windowMinutes * MINUTE
  const untilReset = lane.resetsAt - now
  if (untilReset <= 0 || untilReset > windowMs) return null

  const left = clamp(100 - lane.usedPercent, 0, 100)
  // Clamped off both ends: at exactly 0 the slope divides by zero, and at
  // exactly 1 the "now" marker sits on the axis line rather than on the chart.
  const elapsed = clamp((windowMs - untilReset) / windowMs, 0.001, 0.999)
  const ideal = 100 * (1 - elapsed)
  const margin = left - ideal
  const slope = (left - 100) / elapsed
  const forecast = elapsed >= FORECAST_NEEDS_ELAPSED

  /*
   * Where the projection ends when there is no projection to draw.
   *
   * With a forecast, a lane that is not being consumed projects flat to the
   * reset, which is a true statement about it. Without one — a window too new
   * to extrapolate — the same values would say "it will stay exactly here",
   * which is a claim nobody made. So an unforecastable window projects to
   * *now*: zero length, nothing asserted, and a caller that forgets to check
   * `forecast` draws nothing rather than a promise.
   */
  let projectedAt = forecast ? 1 : elapsed
  let projectedLeft = left
  let runsOut = false
  let etaMs: number | null = null
  if (forecast && slope < -0.01) {
    const crossesAt = elapsed + left / -slope
    // Strictly before the reset. A burn that lands exactly on empty at the
    // moment the window refills has not run out — it is the sustainable rate,
    // which is the one case where the projection meets the diagonal.
    if (crossesAt < 1) {
      projectedAt = crossesAt
      projectedLeft = 0
      runsOut = true
      etaMs = Math.max(0, (crossesAt - elapsed) * windowMs)
    } else {
      projectedLeft = Math.max(0, left + slope * (1 - elapsed))
    }
  }

  return {
    elapsed,
    left,
    ideal,
    margin,
    slope,
    projectedAt,
    projectedLeft,
    runsOut,
    status: statusOf(left, margin),
    forecast,
    etaMs,
    windowMs,
    startsAt: lane.resetsAt - windowMs,
    resetsAt: lane.resetsAt,
  }
}

const statusOf = (left: number, margin: number): BurnStatus => {
  if (left <= 0.5) return 'spent'
  if (left >= 99.5) return 'fresh'
  if (margin > MARGIN_BAND) return 'conserving'
  if (margin < -MARGIN_BAND) return 'overPace'
  return 'onPace'
}

/**
 * The word the badge wears.
 *
 * Deliberately not the same vocabulary as the tone: "over pace" is a fact
 * about the rate, and whether that is *bad* depends on how much is left and
 * how long is left, which the card decides.
 */
export const burnWord = (status: BurnStatus): string => {
  switch (status) {
    case 'fresh':
      return 'full'
    case 'conserving':
      return 'conserving'
    case 'onPace':
      return 'on pace'
    case 'overPace':
      return 'over pace'
    case 'spent':
      return 'spent'
  }
}

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value
