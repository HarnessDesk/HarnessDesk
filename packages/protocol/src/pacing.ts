import { bindingLane, isBlocked, isLaneKnown, reachedLaneOf, remainingOf, type UsageLane, type UsageReport } from './usage.js'

/**
 * Account pacing: which of an agent's accounts to use first so that nothing is
 * left to expire. The desk, the Lead and the phone all ask this module, so the
 * order a person sees, the account the Lead starts a chat on and the note on
 * the phone's Usage tab cannot disagree. It reads only the usage reports the
 * host already keeps; it never asks a vendor for anything.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Below this share left an account has room on paper only; it is tried after one with more. */
export const PACE_HEADROOM_PERCENT = 10

/** More than this share left, with the reset close, is allowance about to be lost. */
export const USE_FIRST_LEFT_PERCENT = 50

/** A window with no stated length counts as close to its reset inside a day. */
const UNSTATED_WINDOW_CLOSE_MS = 24 * HOUR

/** "Close" means no more than this share of the window's own length remains. */
const CLOSE_SHARE = 1 / 4

/** How a reading is old enough that it should not decide anything. */
const isStale = (report: UsageReport, now: number): boolean => now - report.fetchedAt > report.staleAfterMs

export interface UseFirstNote {
  readonly laneId: string
  readonly remainingPercent: number
  /** Epoch milliseconds. */
  readonly resetsAt: number
}

/** The windows that limit the whole account: known, real, and not narrowed to one model. */
const wideLanes = (report: UsageReport): UsageLane[] =>
  report.lanes.filter(lane => lane.placeholder !== true && !lane.scope && isLaneKnown(lane))

/**
 * Whether an account has an account-wide window that is about to reset with more than half still unused: the
 * allowance that expires if nobody spends it. Quiet by construction: a stale or failed reading, a window scoped to
 * one model, a placeholder, a spent account and an unlimited window never raise it, and neither does an account
 * whose *tightest* account-wide window is nearly spent: a roomy five-hour window does not make an account worth
 * using first when its week is almost gone. The bar for "nearly spent" is `PACE_HEADROOM_PERCENT`, the same one
 * the ordering uses, so the note and the order cannot disagree.
 */
export const useFirstNote = (report: UsageReport, now: number): UseFirstNote | null => {
  if (report.error || isStale(report, now) || isBlocked(report)) return null
  const wide = wideLanes(report)
  // A window that has already refilled says nothing about what is left; the others still have to have room.
  const live = wide.filter(lane => lane.resetsAt === null || lane.resetsAt > now)
  if (live.some(lane => (remainingOf(lane) ?? 100) < PACE_HEADROOM_PERCENT)) return null
  let best: UseFirstNote | null = null
  for (const lane of live) {
    const left = remainingOf(lane)
    if (left === null || left <= USE_FIRST_LEFT_PERCENT || lane.resetsAt === null) continue
    const untilReset = lane.resetsAt - now
    const close = lane.windowMinutes !== null && lane.windowMinutes > 0
      ? lane.windowMinutes * MINUTE * CLOSE_SHARE
      : UNSTATED_WINDOW_CLOSE_MS
    if (untilReset > close) continue
    if (best === null || lane.resetsAt < best.resetsAt) best = { laneId: lane.id, remainingPercent: left, resetsAt: lane.resetsAt }
  }
  return best
}

/** Where one account stands for ordering: a tier, then the reset that decides ties inside the first tier. */
export interface PaceRank {
  /** 0 has room and a known reset; 1 has room, reset unknown; 2 is nearly spent; 3 is out. */
  readonly tier: 0 | 1 | 2 | 3
  readonly resetsAt: number | null
}

const rankOfReport = (report: UsageReport, now: number): PaceRank => {
  // A failed or stale reading proves nothing, in either direction: a "reached" it still carries may be long over.
  if (report.error || isStale(report, now)) return { tier: 1, resetsAt: null }
  if (isBlocked(report)) {
    // Out until the window that spent it refills; once its reset has passed, nobody has read it since.
    const spent = reachedLaneOf(report) ?? bindingLane(report.lanes)
    return spent && spent.resetsAt !== null && spent.resetsAt <= now ? { tier: 1, resetsAt: null } : { tier: 3, resetsAt: null }
  }
  const wide = wideLanes(report)
  // A window whose reset has passed has refilled whatever it last read, so it neither limits nor leads.
  const live = (wide.length > 0 ? wide : report.lanes.filter(lane => lane.placeholder !== true && isLaneKnown(lane)))
    .filter(lane => lane.resetsAt === null || lane.resetsAt > now)
  // An account is only as roomy as its tightest window.
  if (live.some(lane => (remainingOf(lane) ?? 100) < PACE_HEADROOM_PERCENT)) return { tier: 2, resetsAt: null }
  const resets = live.flatMap(lane => lane.resetsAt === null ? [] : [lane.resetsAt])
  return resets.length === 0 ? { tier: 1, resetsAt: null } : { tier: 0, resetsAt: Math.min(...resets) }
}

/** A runtime's rank is that of its best report; one with no report at all is unmetered, so it has room. */
export const paceRankOf = (reports: readonly UsageReport[], now: number): PaceRank => {
  if (reports.length === 0) return { tier: 1, resetsAt: null }
  return reports.map(report => rankOfReport(report, now)).reduce((best, next) =>
    next.tier < best.tier || next.tier === best.tier && (next.resetsAt ?? Infinity) < (best.resetsAt ?? Infinity) ? next : best)
}

/**
 * The accounts in the order "Prefer the account that resets soonest" uses them: those with room first, the one
 * whose window refills soonest leading; ties and unknowns keep the person's own order. Stable, and it never drops
 * an entry.
 */
export const pacedOrder = <T extends { readonly id: string }>(
  entries: readonly T[],
  reportsFor: (id: string) => readonly UsageReport[],
  now: number,
): T[] => {
  const ranked = entries.map((entry, at) => ({ entry, at, rank: paceRankOf(reportsFor(entry.id), now) }))
  ranked.sort((a, b) =>
    a.rank.tier - b.rank.tier ||
    (a.rank.tier === 0 ? a.rank.resetsAt! - b.rank.resetsAt! : 0) ||
    a.at - b.at)
  return ranked.map(one => one.entry)
}
