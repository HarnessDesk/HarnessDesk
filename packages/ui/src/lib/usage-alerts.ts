import type { RuntimeId, UsageReport } from '@harnessdesk/protocol'

import {
  bindingLane,
  describeLane,
  describeReport,
  formatCountdown,
  isBlocked,
  pace,
  remainingOf,
} from './usage'

/**
 * When a plan is worth interrupting someone about.
 *
 * Three events, three volumes. Passing 80% and then 95% is a *toast*: news you
 * can act on later. Being out, or being on a pace that will not reach the
 * reset, is a *banner*: a condition, not an event, and it stays up while it is
 * true. Nothing else ever speaks.
 *
 * A crossing is only announced when the desk actually witnessed it — the reading
 * before it was under the line and the one after is over. An agent that was
 * already at 90% when the window opened says nothing, because "you crossed 80%"
 * would be a claim about something nobody saw, and because being greeted by
 * three toasts on launch teaches people to dismiss them without reading.
 */

/** The two lines worth a word. Below 80 is noise; above 95 the banner takes over. */
export const THRESHOLDS = [80, 95] as const

export interface UsageAlert {
  /** Stable across re-renders: agent, account, lane, reset cycle, line crossed. */
  readonly key: string
  readonly runtime: RuntimeId
  readonly message: string
}

const cycleOf = (resetsAt: number | null): string => (resetsAt === null ? 'none' : String(resetsAt))

/* The account is part of it, when a report names one: one agent can report
   for two, a personal and a work Codex, and keyed without it the two readings
   overwrote each other, so one account's reading was compared with the
   other's (#88). A report that names none, whether null, left out or empty,
   keys as it always did (review, round 1). */
const laneKey = (report: UsageReport, laneId: string, resetsAt: number | null): string =>
  `${report.runtime}${report.account ? `@${report.account}` : ''}:${laneId}:${cycleOf(resetsAt)}`

/** Every known lane in a set of reports, by agent, account, lane and reset cycle. */
const index = (reports: readonly UsageReport[]): Map<string, { report: UsageReport; usedPercent: number }> => {
  const map = new Map<string, { report: UsageReport; usedPercent: number }>()
  for (const report of reports) {
    for (const lane of report.lanes) {
      if (lane.usageKnown === false || lane.placeholder === true) continue
      map.set(laneKey(report, lane.id, lane.resetsAt), { report, usedPercent: lane.usedPercent })
    }
  }
  return map
}

/**
 * The lines crossed between two readings.
 *
 * Stateless on purpose: "was under, now over" is the whole rule, so there is no
 * set of announced keys to keep, invalidate, or get wrong when a window resets.
 */
export const crossings = (
  before: readonly UsageReport[],
  after: readonly UsageReport[],
  nameFor: (runtime: RuntimeId) => string,
  now: number,
): readonly UsageAlert[] => {
  const previous = index(before)
  const alerts: UsageAlert[] = []

  for (const report of after) {
    for (const lane of report.lanes) {
      if (lane.usageKnown === false || lane.placeholder === true) continue
      const key = laneKey(report, lane.id, lane.resetsAt)
      const was = previous.get(key)
      // Nothing to compare against: the first sight of a lane is not an event.
      if (!was) continue
      for (const threshold of THRESHOLDS) {
        if (was.usedPercent >= threshold || lane.usedPercent < threshold) continue
        const view = describeLane(lane, now)
        const left = view.remainingPercent === null ? '' : `${view.remainingPercent}% left`
        const back = view.countdown ? `, back in ${view.countdown}` : ''
        alerts.push({
          key: `${key}:${threshold}`,
          runtime: report.runtime,
          message: `${nameFor(report.runtime)} — ${view.title} is ${threshold}% used${left ? `, ${left}` : ''}${back}.`,
        })
      }
    }
  }
  return alerts
}

export interface UsageCondition {
  readonly runtime: RuntimeId
  /**
   * The sentence this is, with the agent and the window taken out — what a
   * reader who never wants to hear it again would be silencing. See
   * `lib/notice-policy.ts`; being out and being on course to run out are two
   * different pieces of news and are silenced separately.
   */
  readonly kind: 'usage:spent' | 'usage:pace'
  /**
   * What this condition *is*, stably, so a dismissal can be remembered
   * against it. Not the sentence: the sentence carries a countdown that moves
   * every minute, and a banner keyed on that would come back every minute.
   * The window it is about is in here, so the same warning stays dismissed
   * until the window turns over and the fact is genuinely new.
   */
  readonly key: string
  readonly tone: 'danger' | 'warning'
  readonly title: string
  readonly detail: string
  /**
   * An agent with room, when this one has none. The desk knows both facts and
   * already knows how to move a conversation, so the banner is not a dead end.
   */
  readonly handoff: { readonly runtime: RuntimeId; readonly name: string } | null
}

/**
 * The window a reset time falls in, to the hour.
 *
 * Not the timestamp itself. Some sources report "resets in N seconds" and the
 * absolute time is computed at each poll, so it drifts by a second or two
 * every minute; keyed on the exact value, a dismissed banner would come back
 * on the next refresh. A reset that moves by a whole hour is a different
 * window, and that is the thing worth telling someone about twice.
 */
const windowOf = (resetsAt: number | null): string =>
  resetsAt === null ? 'open' : String(Math.round(resetsAt / 3_600_000))

/** How much of its binding lane an agent still has, or null when it cannot say. */
const leftOn = (report: UsageReport): number | null => {
  const lane = bindingLane(report.lanes)
  return lane ? remainingOf(lane) : null
}

/**
 * The condition the pane is in, if it is in one.
 *
 * Only ever about the agent the conversation actually talks to: a banner over
 * this transcript is a statement about *this* work, and another agent's weekly
 * limit is not that. The rest of the roster appears only as the way out.
 */
export const conditionFor = (
  runtime: RuntimeId | null,
  reports: readonly UsageReport[],
  nameFor: (runtime: RuntimeId) => string,
  now: number,
): UsageCondition | null => {
  if (runtime === null) return null
  const report = reports.find((entry) => entry.runtime === runtime)
  if (!report) return null
  const view = describeReport(report, { now, maxLanes: 1 })
  const lane = view.hero
  if (!lane) return null

  // Somewhere else to go: the roomiest other agent, and only if it has real
  // room. Offering a hand-off to an agent at 3% would be a worse dead end.
  const alternatives = reports
    .filter((entry) => entry.runtime !== runtime)
    .map((entry) => ({ entry, left: leftOn(entry) }))
    .filter((option): option is { entry: UsageReport; left: number } => option.left !== null && option.left >= 20)
    .sort((a, b) => b.left - a.left)
  const best = alternatives[0]
  const handoff = best ? { runtime: best.entry.runtime, name: nameFor(best.entry.runtime) } : null

  // Only an account-wide limit earns a banner. One model being spent is a
  // fact for the card, not a reason to offer someone another agent.
  const spent = isBlocked(report)
  if (spent) {
    const back = lane.resetsAt !== null ? formatCountdown(lane.resetsAt - now) : null
    return {
      runtime,
      kind: 'usage:spent',
      key: `usage:spent:${runtime}:${lane.id}:${windowOf(lane.resetsAt)}`,
      tone: 'danger',
      title: `${nameFor(runtime)} is out of quota`,
      detail: [
        back ? `${lane.title} is back in ${back}` : `${lane.title} is spent`,
        'past sessions are still readable',
      ].join(' — '),
      handoff,
    }
  }

  // A lane that is on course to run out before it refills. The card says this
  // in a line of its own; here it earns a banner because it changes what to
  // start next, not just what to know.
  const projection = pace(
    report.lanes.find((entry) => entry.id === lane.id) ?? report.lanes[0]!,
    now,
  )
  if (projection && !projection.willLastToReset && projection.etaMs !== null) {
    const runsOut = formatCountdown(projection.etaMs)
    const back = lane.resetsAt !== null ? formatCountdown(lane.resetsAt - now) : null
    if (runsOut) {
      return {
        runtime,
        kind: 'usage:pace',
        key: `usage:pace:${runtime}:${lane.id}:${windowOf(lane.resetsAt)}`,
        tone: 'warning',
        title: `${nameFor(runtime)} will run out before it refills`,
        detail: [`${lane.title} runs out in ${runsOut}`, back ? `it resets in ${back}` : null]
          .filter(Boolean)
          .join(', and '),
        handoff,
      }
    }
  }

  return null
}
