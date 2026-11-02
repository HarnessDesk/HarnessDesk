import type { AccountStatus, RuntimeHealth, RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import type { Tone } from './limits'
import { prefsForUsage, type AccountPrefsMap } from './accounts'
import { readinessOf } from './readiness'
import { describeReport, formatWhen, toneForRemaining, usageStandingOf, workingAccount, type LaneView, type UsagePreference } from './usage'

/**
 * What the strip in the conversation header draws, whatever the size of the
 * roster. Design: `docs/usage-dashboard.md`.
 *
 * The strip used to be one bar per metered agent, which made it a dashboard —
 * and a dashboard grows. `.strip` is inelastic and the session's name is the
 * only elastic thing in that row, so every agent added was subtracted from the
 * name of the conversation you were in, until the title was eight characters
 * and an ellipsis. Growth in accounts is worse than growth in agents: one
 * agent can hold several.
 *
 * So the unit changes. A conversation header has room for exactly two facts,
 * and needs no more:
 *
 * 1. **The anchor** — this conversation's own agent, the one that decides
 *    whether the next Send starts. Fixed slot, first, never re-ordered.
 * 2. **The rest** — one token of constant width for every other agent, which
 *    says whether anything over there is in the way, and nothing else.
 *
 * An agent that is *out* and is not the anchor gets a chip of its own between
 * the two, up to `MAX_PROMOTED`, because "Codex is out for two hours" is a
 * fact you act on and a number in a token cannot say who. The chips are an
 * addition, never a subtraction: the token summarises the whole non-anchor
 * roster whether or not a chip names part of it, so a narrower header can drop
 * the chips without dropping a fact.
 *
 * Everything here is a pure function of the snapshot and a clock, the way
 * `lib/tray.ts` is: the component draws, and decides nothing.
 */

/** How many out-of-quota agents earn their own chip before the token takes over. */
export const MAX_PROMOTED = 2

/** One account's bar, ready to draw. */
export interface StripMeter {
  readonly runtime: RuntimeId
  readonly info: RuntimeInfo
  readonly report: UsageReport
  readonly name: string
  /** Named only when the agent is signed in to more than one account here. */
  readonly account: string | null
  readonly lane: LaneView
  readonly tone: Tone
  /** "71%", or the countdown once there is nothing left. */
  readonly figure: string
  /** Spent, or under `LOW`: the figure is worth the pixels at any width. */
  readonly low: boolean
  readonly out: boolean
  /** The last read failed: the cached lane is drawn, but no figure, out state or Back time is said from it. */
  readonly unread: boolean
  /** Its balance, not a window, stopped it: a top-up brings it back, not a reset. */
  readonly onCredits: boolean
  /** When a spent account is back: the last of the windows that stopped it, not the headline's own reset. */
  readonly backAt: number | null
  /** "Codex — Weekly, 12% left" */
  readonly title: string
}

/** The anchor slot: a bar, the one thing that stops a turn, or nothing. */
export type StripAnchor =
  | { readonly kind: 'meter'; readonly meter: StripMeter }
  | { readonly kind: 'signIn'; readonly info: RuntimeInfo }

/** An agent the token stands for that has no bar to draw. */
export interface StripAside {
  readonly runtime: RuntimeId
  readonly info: RuntimeInfo
  /** "Needs sign-in", "Unavailable", "No usage reported". */
  readonly detail: string
}

/** Every other agent, in the space of a word. */
export interface StripRest {
  /** How many agents it stands for — the anchor's is never one of them. */
  readonly count: number
  readonly out: number
  /** Of `out`, the ones a spent or overdrawn balance stopped rather than a window. */
  readonly outOfCredits: number
  readonly low: number
  readonly signIn: number
  /** Least left among the ones it stands for that report a figure. */
  readonly leastLeft: number | null
  readonly tone: Tone
  /** "2 out", "62%", "5" — in that order of what matters. */
  readonly figure: string
  /** The sentence the token carries as its tooltip and its panel heading. */
  readonly title: string
  /** Panel rows, in roster order: one per account that reports a lane. */
  readonly meters: readonly StripMeter[]
  /** Panel rows for the agents with no bar, so the panel is the whole roster. */
  readonly asides: readonly StripAside[]
}

export interface StripView {
  readonly anchor: StripAnchor | null
  /** Out-of-quota agents promoted out of the token, up to `MAX_PROMOTED`. */
  readonly promoted: readonly StripMeter[]
  readonly rest: StripRest | null
}

export interface StripInput {
  readonly runtimes: readonly RuntimeInfo[]
  readonly usage: readonly UsageReport[]
  readonly accountsByRuntime: Readonly<Partial<Record<RuntimeId, AccountStatus>>>
  readonly accountPrefs: AccountPrefsMap
  readonly health: RuntimeHealth | null
  readonly activeRuntime: RuntimeId | null
  /**
   * The agent this conversation belongs to. The header is about that agent, so
   * it is the anchor; with no conversation open the selected agent stands in.
   */
  readonly sessionRuntime: RuntimeId | null
  readonly now: number
}

/** Under this, a figure is worth the pixels at any width. */
const LOW = 20

const meterFor = (
  info: RuntimeInfo,
  report: UsageReport,
  now: number,
  preference: UsagePreference,
): StripMeter | null => {
  const view = describeReport(report, { now, maxLanes: 1, preference })
  const lane = view.hero
  // No lane is no bar. A permanent row of dashes teaches people to stop
  // looking, and the screen is where "why is this one missing" is answered.
  if (!lane || !lane.known || lane.remainingPercent === null) return null
  // A failed read keeps its last lanes, but none of them is current: the card, Plans and the phone say Unknown, so
  // the strip neither counts nor promotes it as out, and says no figure or Back time from the cached lane.
  const standing = usageStandingOf(report, now)
  const unread = standing.status === 'unknown'
  // The balance decided (the source hit its credits): the healthy window beside it is no figure to show.
  const onCredits = !unread && standing.lane === null && (standing.status === 'out' || standing.status === 'overdrawn')
  const spent = !unread && !onCredits && lane.remainingPercent <= 0
  // An out account is back when every window that stopped it has reset, which
  // the standing knows; the headline's own reset can come hours earlier.
  const backAt = standing.status === 'out' ? standing.backAt : lane.resetsAt
  const name = info.presentation.name
  return {
    runtime: report.runtime,
    info,
    report,
    name,
    // Filled in by `named` once the whole roster is known: whether an account
    // needs saying depends on the company it keeps.
    account: null,
    lane,
    // The card's tone folds in pace, which is a prediction. A bar 34px wide
    // has no room to explain a prediction, and an unexplained amber at 71%
    // left is noise — so the strip colours what *is*, and pace stays on the
    // panel and the card, where a sentence sits beside it.
    tone: unread ? 'warn' : onCredits || view.gated || view.blocked ? 'bad' : lane.tone,
    // Out of quota is the one state where the percentage is not the useful
    // number. When it comes back is — as a time, which stays true without a
    // refresh, where "3h" was already wrong by the time it was read.
    figure: unread ? '—' : onCredits ? (standing.status === 'overdrawn' ? 'overdrawn' : 'no credits') : spent ? (backAt !== null && backAt > now ? `back ${formatWhen(backAt, now)}` : 'out') : `${lane.remainingPercent}%`,
    // Low as the standing says it, too: a healthy headline can sit in front of a Weekly that is the low one.
    low: !unread && (onCredits || spent || lane.remainingPercent < LOW || standing.status === 'low'),
    out: !unread && (onCredits || view.blocked),
    unread,
    onCredits,
    backAt: spent ? backAt : null,
    title: unread
      ? `${name} — ${lane.title}, no current reading`
      : onCredits
        ? `${name} — ${standing.status === 'overdrawn' ? 'overdrawn' : 'out of credits'}, until it is topped up`
        : `${name} — ${lane.title}, ${lane.remainingPercent}% left`,
  }
}

/**
 * A name says which agent only while it is the agent's alone.
 *
 * Two accounts on one agent is the obvious case, and the one a second report
 * under the same runtime makes visible. The case that actually bites is a
 * *symlink farm*: each Codex account is registered as its own runtime, so the
 * roster holds two agents both called "OpenAI Codex", and neither report can
 * tell that from where it sits. So the account is named whenever the name it
 * sits under is not unique in the roster — never on the strength of the
 * report alone.
 */
const named = (meter: StripMeter, names: ReadonlyMap<string, number>): StripMeter => {
  const account = (names.get(meter.name) ?? 0) > 1 ? meter.report.account : null
  if (account === null) return meter
  return {
    ...meter,
    account,
    // The account goes beside the name; what the title says after it — a figure, Unknown, a debt — stays.
    title: `${meter.name} · ${account}${meter.title.slice(meter.name.length)}`,
  }
}

/** One agent, resolved down to the account that decides and what it says. */
interface Entry {
  readonly info: RuntimeInfo
  readonly meter: StripMeter | null
  readonly meters: readonly StripMeter[]
  readonly needsSignIn: boolean
  readonly detail: string
}

const entryFor = (info: RuntimeInfo, input: StripInput): Entry => {
  const reports = input.usage.filter((report) => report.runtime === info.id)
  const state = readinessOf({
    registered: true,
    // The snapshot carries health for the selected agent only, which is the
    // same thing the menu bar has to live with.
    health: info.id === input.activeRuntime ? input.health : null,
    account: input.accountsByRuntime[info.id],
    accounts: info.capabilities.account,
    usage: reports,
  })
  const preferenceFor = (report: UsageReport): UsagePreference =>
    prefsForUsage(report.runtime, report.account, input.accountsByRuntime, input.accountPrefs) ?? {}
  const meters = reports
    .map((report) => meterFor(info, report, input.now, preferenceFor(report)))
    .filter((meter): meter is StripMeter => meter !== null)
  // The account that decides, not the first one that happened to arrive — and one whose read failed only when no
  // account has a current reading: a cached 90% is not a reason to stand in front of a live 40%.
  const live = reports.filter((report) => usageStandingOf(report, input.now).status !== 'unknown')
  const decided = workingAccount(live.length > 0 ? live : reports, preferenceFor)
  const meter =
    meters.find((entry) => entry.report === decided) ?? meters.find((entry) => !entry.unread) ?? meters[0] ?? null
  return {
    info,
    meter,
    meters,
    // A live reading outranks a missing account entry: the reports arrive
    // before `accountsByRuntime` does on a cold start, and an agent that just
    // told us what it has left is not an agent to ask for a password.
    needsSignIn: state === 'signin' && meters.length === 0,
    detail:
      state === 'signin' ? 'Needs sign-in' : state === 'broken' ? 'Unavailable' : 'No usage reported',
  }
}

const restFigure = (out: number, leastLeft: number | null, count: number): string => {
  if (out > 0) return `${out} out`
  if (leastLeft !== null) return `${leastLeft}%`
  return `${count}`
}

const restTitle = (rest: Omit<StripRest, 'title' | 'figure' | 'tone'>): string => {
  const head = `${rest.count} other ${rest.count === 1 ? 'runtime' : 'runtimes'}`
  const parts: string[] = []
  if (rest.out > rest.outOfCredits) parts.push(`${rest.out - rest.outOfCredits} out of quota`)
  if (rest.outOfCredits > 0) parts.push(`${rest.outOfCredits} out of credits`)
  if (rest.low > 0) parts.push(`${rest.low} running low`)
  if (rest.leastLeft !== null) parts.push(`least left ${rest.leastLeft}%`)
  if (rest.signIn > 0) parts.push(`${rest.signIn} needs sign-in`)
  if (parts.length === 0) parts.push('nothing reported')
  return `${head} — ${parts.join(', ')}`
}

export const describeStrip = (input: StripInput): StripView => {
  const anchorId = input.sessionRuntime ?? input.activeRuntime
  const raw = input.runtimes.map((info) => entryFor(info, input))

  // How many bars each display name has to cover, counted across the whole
  // roster — the only place from which a duplicate name is visible at all.
  const names = new Map<string, number>()
  for (const entry of raw) {
    for (const meter of entry.meters) names.set(meter.name, (names.get(meter.name) ?? 0) + 1)
  }
  const entries = raw.map((entry) => {
    const meters = entry.meters.map((meter) => named(meter, names))
    return {
      ...entry,
      meters,
      meter: entry.meter === null ? null : (meters[entry.meters.indexOf(entry.meter)] ?? null),
    }
  })

  const anchorEntry = entries.find((entry) => entry.info.id === anchorId) ?? null
  const anchor: StripAnchor | null =
    anchorEntry === null
      ? null
      : anchorEntry.meter !== null
        ? { kind: 'meter', meter: anchorEntry.meter }
        : anchorEntry.needsSignIn
          ? // The one thing that stops this conversation starting at all,
            // offered where the conversation is.
            { kind: 'signIn', info: anchorEntry.info }
          : null

  // Roster order, never re-sorted by urgency: this is chrome you glance at a
  // hundred times a day, and chrome that rearranges itself has to be read
  // every time. Colour carries the alarm; the token carries the count.
  const others = entries.filter((entry) => entry !== anchorEntry)
  const decided = others
    .map((entry) => entry.meter)
    .filter((meter): meter is StripMeter => meter !== null)
  const promoted = decided.filter((meter) => meter.out).slice(0, MAX_PROMOTED)

  // A failed read's cached percentage is no figure: the least left is said only from current readings.
  const figures = decided
    .filter((meter) => !meter.out && !meter.unread)
    .map((meter) => meter.lane.remainingPercent)
    .filter((left): left is number => left !== null)
  const out = decided.filter((meter) => meter.out).length
  const counted = {
    count: others.length,
    out,
    outOfCredits: decided.filter((meter) => meter.out && meter.onCredits).length,
    low: decided.filter((meter) => meter.low && !meter.out).length,
    signIn: others.filter((entry) => entry.needsSignIn).length,
    leastLeft: figures.length > 0 ? Math.min(...figures) : null,
    meters: others.flatMap((entry) => entry.meters),
    asides: others
      .filter((entry) => entry.meters.length === 0)
      .map((entry) => ({ runtime: entry.info.id, info: entry.info, detail: entry.detail })),
  }

  return {
    anchor,
    promoted,
    rest:
      others.length === 0
        ? null
        : {
            ...counted,
            tone: out > 0 ? 'bad' : toneForRemaining(counted.leastLeft),
            figure: restFigure(out, counted.leastLeft, others.length),
            title: restTitle(counted),
          },
  }
}
