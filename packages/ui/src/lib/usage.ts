import {
  bindingLane,
  isBlocked,
  isLaneKnown,
  reachedLaneOf,
  remainingOf,
  type SpendSummary,
  type UsageLane,
  type UsagePreference,
  type UsageReport,
} from '@harnessdesk/protocol'

import { burn, MARGIN_BAND, type BurnView } from './burn'
import { formatReset, type Tone } from './limits'

/**
 * The arithmetic behind the Usage screen. Design: `docs/usage-dashboard.md`.
 *
 * Everything here is a pure function of a report and a clock, so the rules that
 * matter — which lane is binding, whether a longer lane gates a shorter one,
 * whether the pace holds to the reset — are tested without a browser. The
 * component decides how to draw; it decides nothing about what is true.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Below this, a lane is amber. At or below zero it is spent. */
const LOW_AT = 20

/*
 * How long a window has to have been open before its pace means anything is
 * `FORECAST_NEEDS_ELAPSED` in `lib/burn.ts`, which is where the arithmetic
 * behind both the chart and the sentence now lives. One threshold, so the
 * projection on the burn-down and the line under the card cannot disagree
 * about whether there is anything to say.
 */

export interface LaneView {
  readonly id: string
  readonly label: string
  /** The lane's own wording plus its scope: "Weekly · Fable only". */
  readonly title: string
  /** The model or feature this lane is limited to, when it is limited to one. */
  readonly scope: string | null
  /** Null when the source reported a window but no figure for it. */
  readonly remainingPercent: number | null
  readonly usedPercent: number | null
  readonly tone: Tone
  readonly resetsAt: number | null
  /** "2d 3h", "3h 20m" — two units, for the headline. */
  readonly countdown: string | null
  /** "3h", "Wed" — one unit, for a compact row. */
  readonly shortCountdown: string | null
  /** "Wed 6:00 PM" — the clock time to plan around. */
  readonly resetClock: string | null
  readonly known: boolean
  readonly spent: boolean
  /**
   * The shape of this window's burn, for the surface that draws it.
   *
   * Carried on the view rather than recomputed at the point of drawing, so
   * the chart, the badge beside it and the sentence under the card are three
   * renderings of one value and cannot drift apart. Null for a lane with no
   * window to plot — see `burn()`.
   */
  readonly burn: BurnView | null
  /**
   * Set when a longer lane is spent, so this one cannot be used however much
   * it shows. A session at 71% behind a spent weekly is not 71% of anything.
   */
  readonly gatedUntil: number | null
  /** How long that hold lasts, in one unit, for the row that has to say it. */
  readonly gatedFor: string | null
}

export type PaceStage = 'onTrack' | 'ahead' | 'behind'

export interface PaceView {
  readonly stage: PaceStage
  /** How far ahead (positive) or behind (negative) the even burn, in points. */
  readonly deltaPercent: number
  readonly expectedUsedPercent: number
  /** Milliseconds until the lane is spent, when it will not last to the reset. */
  readonly etaMs: number | null
  readonly willLastToReset: boolean
  /** "14% ahead of pace · runs out in 2d 9h" */
  readonly text: string
  readonly tone: Tone
}

export interface ReportView {
  /** The lane with the least left — the one that decides whether work can happen. */
  readonly hero: LaneView | null
  /** The rest, in the source's own order, capped by `maxLanes`. */
  readonly lanes: readonly LaneView[]
  /**
   * Every lane the card draws, headline included, in the source's own order.
   *
   * A card that shows one figure at the top and a list of sentences below it
   * was answering on two scales at once — "10% left" over "24% used" — and a
   * reader had to convert one into the other to see which window was the one
   * that bit. So the card draws a single table where every row means what is
   * left, and the headline is whichever row of *that* table has least: it is
   * a promotion, not a second number. Which means the table has to contain
   * the promoted row too.
   */
  readonly all: readonly LaneView[]
  /** Which row of `all` was promoted to the headline. */
  readonly heroId: string | null
  /** Counted against every lane the source reported, not the subset drawn. */
  readonly overflow: number
  readonly tone: Tone
  readonly pace: PaceView | null
  /** True when any drawn lane is held behind a spent longer one. */
  readonly gated: boolean
  /** True when nothing can run: the account-wide lane is spent, not one model's. */
  readonly blocked: boolean
  readonly reached: string | null
  /** The lane `reached` names, resolved — a scoped one says which model. */
  readonly reachedLane: LaneView | null
  readonly stale: boolean
  readonly age: string
}

/*
 * Whether an account can work at all — `remainingOf`, `bindingLane`,
 * `reachedLaneOf`, `isBlocked` — is decided in `@harnessdesk/protocol`, beside
 * the report it reads, because the host asks it too before it seats an Agent.
 * Re-exported here so every surface keeps asking this module.
 */
export { bindingLane, isBlocked, reachedLaneOf, remainingOf, type UsagePreference }

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value

/**
 * Rounds to the nearest whole unit rather than truncating: 47h59m reads as two
 * days to a person, not the one day flooring produces.
 */
export const formatCountdown = (ms: number): string | null => {
  if (!Number.isFinite(ms) || ms <= 0) return null
  if (ms < HOUR) {
    // Rounding can carry into the next unit at every boundary — 59½ minutes
    // is 60, 23 hours and 59½ minutes is 24 — and each carry is said in the
    // unit above it, never as "60m" or "24h".
    const minutes = Math.max(1, Math.round(ms / MINUTE))
    return minutes === 60 ? '1h' : `${minutes}m`
  }
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.round((ms % HOUR) / MINUTE)
    if (minutes === 60) {
      const nextHours = hours + 1
      return nextHours === 24 ? '1d' : `${nextHours}h`
    }
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  const days = Math.floor(ms / DAY)
  const hours = Math.round((ms % DAY) / HOUR)
  if (hours === 24) return `${days + 1}d`
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

/** One unit only, for a row that has no space for two. */
export const formatCountdownShort = (ms: number): string | null => {
  if (!Number.isFinite(ms) || ms <= 0) return null
  if (ms < HOUR) {
    const minutes = Math.max(1, Math.round(ms / MINUTE))
    return minutes === 60 ? '1h' : `${minutes}m`
  }
  if (ms < DAY) {
    const hours = Math.round(ms / HOUR)
    return hours >= 24 ? '1d' : `${Math.max(1, hours)}h`
  }
  return `${Math.max(1, Math.round(ms / DAY))}d`
}

export const toneForRemaining = (remaining: number | null): Tone => {
  if (remaining === null) return 'good'
  if (remaining <= 0) return 'bad'
  return remaining < LOW_AT ? 'warn' : 'good'
}

const severityTone = (lane: UsageLane): Tone | null => {
  if (lane.severity === 'critical') return 'bad'
  if (lane.severity === 'warning') return 'warn'
  return null
}

const worst = (a: Tone, b: Tone): Tone => {
  const rank: Record<Tone, number> = { good: 0, warn: 1, bad: 2 }
  return rank[a] >= rank[b] ? a : b
}

export const describeLane = (
  lane: UsageLane,
  now: number,
  siblings: readonly UsageLane[] = [],
): LaneView => {
  const remaining = remainingOf(lane)
  const untilReset = lane.resetsAt === null ? null : lane.resetsAt - now
  const known = isLaneKnown(lane)
  const gate = gatedUntil(lane, siblings, now)
  return {
    id: lane.id,
    label: lane.label,
    title: lane.scope ? `${lane.label} · ${lane.scope}` : lane.label,
    scope: lane.scope ?? null,
    remainingPercent: remaining === null ? null : Math.round(remaining),
    usedPercent: known ? clamp(lane.usedPercent, 0, 100) : null,
    tone: severityTone(lane) ?? toneForRemaining(remaining),
    resetsAt: lane.resetsAt,
    countdown: untilReset === null ? (lane.resetText ?? null) : formatCountdown(untilReset),
    shortCountdown:
      untilReset === null ? (lane.resetText ?? null) : formatCountdownShort(untilReset),
    resetClock: formatReset(lane.resetsAt, now),
    known,
    spent: remaining !== null && remaining <= 0,
    burn: burn(lane, now),
    gatedUntil: gate,
    gatedFor: gate === null ? null : formatCountdownShort(gate - now),
  }
}

/**
 * When a longer lane is spent, the shorter one cannot be used either, whatever
 * its own figure says — and it cannot come back before the last of those gates
 * resets. Returns null when nothing longer is blocking.
 *
 * An unknown reset on a live blocker withholds the date rather than promising
 * an earlier one we can see.
 */
export const gatedUntil = (
  subject: UsageLane,
  lanes: readonly UsageLane[],
  now: number,
): number | null => {
  const subjectMinutes = subject.windowMinutes ?? 0
  const blockers = lanes.filter((lane) => {
    if (lane.id === subject.id || lane.placeholder === true) return false
    // A model running out blocks that model, not the session: switch models and
    // the work continues. Only an account-wide lane gates anything.
    if (lane.scope) return false
    if ((lane.windowMinutes ?? 0) <= subjectMinutes) return false
    const remaining = remainingOf(lane)
    if (remaining === null || remaining > 0) return false
    return lane.resetsAt === null || lane.resetsAt > now
  })
  if (blockers.length === 0) return null
  if (blockers.some((lane) => lane.resetsAt === null)) return null
  return blockers.reduce((latest, lane) => Math.max(latest, lane.resetsAt ?? 0), 0)
}

/**
 * Share used against share of window elapsed, in words.
 *
 * A presenter over `burn()` rather than a second calculation. The two used to
 * be one function that returned a sentence, which meant the four coordinates
 * it computed on the way — how much is gone, how much should be gone, the
 * slope, where it crosses zero — existed for the length of one expression and
 * were then spent on eight words. They are a chart, so they are now a value,
 * and this is the sentence drawn from it. Sign convention: `margin` is what is
 * left *above* the sustainable rate, and `deltaPercent` is how far *ahead of*
 * it the burn is, which is its negation.
 *
 * Null when the arithmetic would be noise: no reset, no window length, a reset
 * further away than a whole window, or a window that has barely opened.
 */
export const pace = (lane: UsageLane, now: number): PaceView | null => {
  const view = burn(lane, now)
  if (view === null || !view.forecast) return null

  const delta = -view.margin
  const expected = 100 - view.ideal
  const willLastToReset = !view.runsOut
  const etaMs = willLastToReset ? null : view.etaMs

  const stage: PaceStage =
    Math.abs(delta) <= MARGIN_BAND ? 'onTrack' : delta > 0 ? 'ahead' : 'behind'
  const rounded = Math.round(Math.abs(delta))
  const lead =
    stage === 'onTrack'
      ? 'On pace'
      : stage === 'ahead'
        ? `${rounded}% ahead of pace`
        : `${rounded}% behind pace`
  const outcome = willLastToReset
    ? 'lasts to reset'
    : etaMs !== null && etaMs > 0
      ? `runs out in ${formatCountdown(etaMs)}`
      : 'spent'
  return {
    stage,
    deltaPercent: delta,
    expectedUsedPercent: expected,
    etaMs,
    willLastToReset,
    text: `${lead} · ${outcome}`,
    tone: willLastToReset ? 'good' : 'warn',
  }
}

/** How old a reading is, in words: "just now", "2m ago", "1h ago". */
export const formatAge = (fetchedAt: number, now: number): string => {
  const ms = Math.max(0, now - fetchedAt)
  if (ms < 45_000) return 'just now'
  const unit = formatCountdownShort(ms)
  return unit === null ? 'just now' : `${unit} ago`
}

/**
 * What the Dashboard draws for a report — and only the Dashboard.
 *
 * A report whose own lanes are empty but which carries another sign-in's
 * figures (`unverified`: Antigravity's, read through the separate `agy` CLI)
 * is drawn with those figures, under that sign-in's name, so the card can
 * show what it has without claiming it is this agent's account. The result is
 * for drawing: readiness, the chip, alerts, the strip and the tray keep
 * reading the report itself, whose lanes are empty, and so never decide
 * anything on an account the desk cannot tie to the agent.
 */
export const drawnReport = (report: UsageReport): UsageReport => {
  const other = report.unverified
  if (!other || report.lanes.length > 0) return report
  return {
    ...report,
    account: other.whose,
    lanes: other.lanes,
    reached: other.reached,
    fetchedAt: other.fetchedAt,
    staleAfterMs: other.staleAfterMs,
    // Its source's failure is what the card's note says; the agent's own
    // error, if it has one, still reaches the chip through the report.
    error: other.error ?? report.error,
  }
}

/**
 * Which of an agent's accounts decides whether it can work.
 *
 * Lanes inside one account are conjunctive — every window has to have room, so
 * the binding lane is the one with *least* left. Accounts are the opposite:
 * signed in to two, either one will run the turn, so the account that decides
 * is the one with the *most* left. It is the rule already kept for a
 * model-scoped lane — a limit you can step around is not a limit on the agent
 * — and without it a spent second account would put a red bar on an agent
 * that has a full one beside it.
 *
 * A measured account outranks an unmeasured one even when it is nearly spent:
 * "3% left" is evidence and silence is not, and a surface that let silence win
 * would go blank on the agent it had most to say about. When every account is
 * spent the one that comes back soonest decides, because when is the only
 * question left. Ties keep the source's own order.
 */
export const workingAccount = (
  reports: readonly UsageReport[],
  preferenceFor: (report: UsageReport) => UsagePreference = () => ({}),
): UsageReport | null => {
  let best: UsageReport | null = null
  for (const report of reports) {
    if (best === null || outbids(report, best, preferenceFor)) best = report
  }
  return best
}

/** 1 measured and usable, 2 usable but unmeasured, 3 spent. Lower decides. */
const accountRank = (report: UsageReport, preferenceFor: (report: UsageReport) => UsagePreference): 1 | 2 | 3 => {
  if (isBlocked(report)) return 3
  const lane = bindingLane(report.lanes, preferenceFor(report))
  return lane !== null && remainingOf(lane) !== null ? 1 : 2
}

const leftOf = (report: UsageReport, preferenceFor: (report: UsageReport) => UsagePreference): number => {
  const lane = bindingLane(report.lanes, preferenceFor(report))
  const remaining = lane === null ? null : remainingOf(lane)
  return remaining ?? 0
}

/** When it comes back, or infinity for a hold whose end nobody reported. */
const returnsAt = (report: UsageReport, preferenceFor: (report: UsageReport) => UsagePreference): number => {
  const lane = bindingLane(report.lanes, preferenceFor(report))
  return lane?.resetsAt ?? Number.POSITIVE_INFINITY
}

const outbids = (
  candidate: UsageReport,
  holder: UsageReport,
  preferenceFor: (report: UsageReport) => UsagePreference,
): boolean => {
  const rank = accountRank(candidate, preferenceFor)
  const held = accountRank(holder, preferenceFor)
  if (rank !== held) return rank < held
  if (rank === 1) return leftOf(candidate, preferenceFor) > leftOf(holder, preferenceFor)
  if (rank === 3) return returnsAt(candidate, preferenceFor) < returnsAt(holder, preferenceFor)
  return false
}

/**
 * One card's view of one account.
 *
 * `maxLanes` is how many rows beside the headline the card can draw; the
 * overflow count is measured against every reported lane, so a lane dropped by
 * the cap is still accounted for rather than silently gone.
 */
export const describeReport = (
  report: UsageReport,
  { now, maxLanes = 3, preference }: { now: number; maxLanes?: number; preference?: UsagePreference },
): ReportView => {
  const drawable = report.lanes.filter((lane) => lane.placeholder !== true)
  const heroLane = bindingLane(report.lanes, preference)
  const hero = heroLane ? describeLane(heroLane, now, report.lanes) : null
  const rest = drawable.filter((lane) => lane.id !== heroLane?.id)
  const shown = rest.slice(0, Math.max(0, maxLanes))
  const lanes = shown.map((lane) => describeLane(lane, now, report.lanes))
  // The same set the card is allowed to draw, but in the source's order and
  // with the headline back among its peers.
  const drawn = new Set<string>(shown.map((lane) => lane.id))
  if (heroLane) drawn.add(heroLane.id)
  const all = drawable
    .filter((lane) => drawn.has(lane.id))
    .map((lane) => describeLane(lane, now, report.lanes))
  const heroPace = heroLane ? pace(heroLane, now) : null
  const gated = [hero, ...lanes].some((view) => view !== null && view.gatedUntil !== null)

  const reachedRaw = reachedLaneOf(report)
  const reachedLane = reachedRaw ? describeLane(reachedRaw, now, report.lanes) : null
  const blocked = isBlocked(report)

  let tone: Tone = hero?.tone ?? 'good'
  if (blocked || gated) tone = 'bad'
  // A model that is out is worth amber on the card, and no more: the account
  // still works with a different one.
  else if (reachedLane) tone = worst(tone, 'warn')
  if (heroPace && !heroPace.willLastToReset) tone = worst(tone, 'warn')

  return {
    hero,
    lanes,
    all,
    heroId: heroLane?.id ?? null,
    overflow: Math.max(0, drawable.length - (heroLane ? 1 : 0) - shown.length),
    tone,
    pace: heroPace,
    gated,
    blocked,
    reached: report.reached,
    reachedLane,
    stale: now - report.fetchedAt > report.staleAfterMs,
    age: formatAge(report.fetchedAt, now),
  }
}

/**
 * Cards come in the order of what is about to bite: spent first, then least
 * left, then the ones with nothing to report. An agent that reports no lanes
 * still sorts by whether it has spend to show, so an empty card never
 * outranks a real one.
 */
export const byUrgency = (reports: readonly UsageReport[]): readonly UsageReport[] =>
  [...reports].sort((a, b) => rank(a) - rank(b))

const rank = (report: UsageReport): number => {
  if (isBlocked(report)) return -1
  const lane = bindingLane(report.lanes)
  const remaining = lane ? remainingOf(lane) : null
  if (remaining !== null) return remaining
  // No measurable lane: after every metered account, but before an empty one.
  return report.spend ? 1_000 : 1_001
}

export interface RunwaySummary {
  readonly exhausted: readonly UsageReport[]
  readonly low: readonly UsageReport[]
  readonly metered: number
  readonly total: number
  /** The soonest reset among the spent lanes, so the sentence can name it. */
  readonly nextReturn: number | null
  readonly headline: string
  readonly detail: string
}

/** Whether a report carries a balance a person could read — a finite one. */
const hasBalance = (report: UsageReport): boolean =>
  typeof report.credits?.remaining === 'number' && Number.isFinite(report.credits.remaining)

/**
 * The one line above the cards.
 *
 * It answers "can I work?" before the reader has looked at a single card, and
 * it names the agent when there is only one to name — a count is worse than a
 * name when the count is one.
 */
export const runway = (
  reports: readonly UsageReport[],
  nameFor: (report: UsageReport) => string,
  now: number,
): RunwaySummary => {
  // A prepaid balance is usage reported as much as a window is: Amp's and
  // Cline's accounts have nothing else, and one of them at zero cannot run a
  // turn, which this line exists to say before anyone reads a card.
  const metered = reports.filter((report) => bindingLane(report.lanes) !== null || hasBalance(report))
  // Figures for another sign-in (`unverified`) never count as an agent's own,
  // here or anywhere; they are only named, so the line above a card full of
  // them does not read as a contradiction of it.
  const borrowed = reports.filter(
    (report) => report.lanes.length === 0 && (report.unverified?.lanes.length ?? 0) > 0,
  )
  const exhausted = metered.filter(isBlocked)
  const low = metered.filter((report) => {
    if (exhausted.includes(report)) return false
    const lane = bindingLane(report.lanes)
    const remaining = lane ? remainingOf(lane) : null
    return remaining !== null && remaining < LOW_AT
  })

  const returns = exhausted
    .map((report) => bindingLane(report.lanes)?.resetsAt ?? null)
    .filter((at): at is number => at !== null && at > now)
  const nextReturn = returns.length > 0 ? Math.min(...returns) : null

  const only = exhausted[0]
  const headline =
    exhausted.length === 1 && only
      ? `${nameFor(only)} is out of ${bindingLane(only.lanes) === null && hasBalance(only) ? 'credits' : 'quota'}.`
      : exhausted.length > 1
        ? `${exhausted.length} agents are out of quota.`
        : low.length === 1
          ? `${nameFor(low[0] as UsageReport)} is running low.`
          : low.length > 1
            ? `${low.length} agents are running low.`
            : metered.length > 0
              ? 'Nothing is close to a limit.'
              : borrowed.length > 0
                ? `No agent here reports its own plan usage — ${
                    borrowed.length === 1
                      ? `${nameFor(borrowed[0] as UsageReport)} shows`
                      : `${borrowed.length} agents show`
                  } another sign-in's.`
                : 'No agent here reports plan usage.'

  const parts: string[] = []
  if (nextReturn !== null) {
    const back = formatCountdown(nextReturn - now)
    if (back) parts.push(`Back in ${back}`)
  }
  if (metered.length > 0) {
    parts.push(
      `${metered.length} of ${reports.length} ${reports.length === 1 ? 'agent reports' : 'agents report'} usage`,
    )
  }

  return {
    exhausted,
    low,
    metered: metered.length,
    total: reports.length,
    nextReturn,
    headline,
    detail: parts.join(' · '),
  }
}

/** "$2.92", "$373", "$4,639" — cents only where they carry information. */
/**
 * A plan name fit to sit on a badge.
 *
 * Sources disagree about case for the same word — Cursor says `Pro`, Codex
 * reports its login method as `team` — and a badge that reads "team" next to
 * one that reads "Pro" looks like two different kinds of fact. Only a label
 * with no capitals at all is touched, so `Max 20x` is left exactly as its
 * source wrote it.
 */
export const planLabel = (plan: string | null): string | null => {
  const trimmed = plan?.trim()
  if (!trimmed) return null
  if (/[A-Z]/.test(trimmed)) return trimmed
  return trimmed.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

export const formatMoney = (amount: number | null, currency = 'USD'): string | null => {
  if (amount === null || !Number.isFinite(amount)) return null
  // The tail of a model list is all fractions of a dollar, so a third digit
  // keeps those rows from reading "$0.00" — without forcing a trailing zero
  // onto the ones that do not need it.
  const most = amount === 0 ? 0 : amount < 1 ? 3 : amount < 100 ? 2 : 0
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: Math.min(most, 2),
      maximumFractionDigits: most,
    }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

/**
 * What the spend figure is worth saying about itself.
 *
 * Takes the two fields rather than a whole summary, so the card and the band
 * — which carry different shapes around the same two facts — say it the same
 * way.
 */
/**
 * What the figures in the money band are, after "Last 30 days —".
 *
 * The band said "what these tokens would have cost at public API rates. Not a
 * bill." of every total, which stopped being true the day an agent's own cost
 * could be counted: OpenCode's and Cline's figures are what they recorded, a
 * free model's zero included, and some of those are bills.
 */
export const spendHint = (provenance: SpendSummary['provenance'] | undefined): string => {
  switch (provenance) {
    case 'vendorMetered':
      return 'what the agents recorded these tokens cost.'
    case 'mixed':
      return 'what the agents recorded, where they did, and public API rates for the rest. Not all of it is a bill.'
    default:
      return 'what these tokens would have cost at public API rates. Not a bill.'
  }
}

export const provenanceLabel = (spend: Pick<SpendSummary, 'provenance'>): string => {
  switch (spend.provenance) {
    case 'listPrice':
      return 'List-price equivalent'
    case 'vendorMetered':
      return 'Plan metered'
    case 'mixed':
      return 'Metered and list-price'
    case 'unknown':
      return 'Spend unavailable'
  }
}

export const coverageLabel = (spend: Pick<SpendSummary, 'coverage'>): string | null => {
  const coverage = spend.coverage
  if (!coverage) return null
  return `${coverage.daysCovered} of ${coverage.daysRequested} days scanned`
}
