import type { RuntimeId } from './ids.js'
import type { UsageReport } from './usage.js'

/** The source a stand-in entry names: the agent is tracked, and nothing has read its allowance. */
export const SILENT_USAGE_SOURCE = 'no source available'

/**
 * The accounts every usage surface lists, the Dashboard, the Runtimes page, the phone and the Lead's summary alike:
 * each reading of an agent the person tracks, and for a tracked agent with none, one entry that says it is not
 * reporting. A reading of an agent the person stopped tracking, or of one no longer on the desk, is not listed.
 * Reading order is kept: tracked agents with readings first in the order given, then the silent ones in roster order.
 */
export const trackedUsage = (
  runtimes: readonly { readonly id: RuntimeId }[],
  reports: readonly UsageReport[],
  off: readonly RuntimeId[],
  now: number,
): readonly UsageReport[] => {
  const skip = new Set(off), known = new Set(runtimes.map(info => info.id))
  const metered = reports.filter(report => known.has(report.runtime) && !skip.has(report.runtime))
  const read = new Set(metered.map(report => report.runtime))
  const silent = runtimes.filter(info => !skip.has(info.id) && !read.has(info.id)).map((info): UsageReport => ({
    runtime: info.id, account: null, plan: null, lanes: [], credits: null, spend: null, reached: null,
    source: { kind: 'runtime', label: SILENT_USAGE_SOURCE }, fetchedAt: now, staleAfterMs: Number.POSITIVE_INFINITY, error: null,
  }))
  return [...metered, ...silent]
}

/** Whether an entry is the stand-in for a tracked agent nothing has read. */
export const isSilentUsage = (report: UsageReport): boolean =>
  report.source?.kind === 'runtime' && report.source.label === SILENT_USAGE_SOURCE && report.lanes.length === 0 &&
  report.credits === null && report.spend === null && report.error === null && !report.unverified

/** The kind an allowance-crossing notice is kept under in the inbox. */
export const USAGE_CROSSING_KIND = 'usage:crossing'
const CROSSING_PREFIX = `${USAGE_CROSSING_KIND}:`

/** What an allowance-crossing notice said: whose window, which cycle of it, and the line it crossed. */
export interface UsageCrossing {
  readonly runtime: RuntimeId
  readonly account: string | null
  readonly lane: string
  readonly resetsAt: number | null
  readonly threshold: number
}

/**
 * The key an allowance-crossing notice is kept under. It carries the figures the notice was about, so whoever holds
 * the inbox can tell, from a newer read alone, whether the notice still holds.
 */
export const usageCrossingKey = (crossing: UsageCrossing): string =>
  CROSSING_PREFIX + JSON.stringify([crossing.runtime, crossing.account?.trim() || null, crossing.lane, crossing.resetsAt, crossing.threshold])

const crossingOf = (key: string): UsageCrossing | null => {
  if (!key.startsWith(CROSSING_PREFIX)) return null
  try {
    const value: unknown = JSON.parse(key.slice(CROSSING_PREFIX.length))
    if (!Array.isArray(value) || value.length !== 5) return null
    const [runtime, account, lane, resetsAt, threshold] = value as unknown[]
    if (typeof runtime !== 'string' || (account !== null && typeof account !== 'string') || typeof lane !== 'string' ||
      (resetsAt !== null && typeof resetsAt !== 'number') || typeof threshold !== 'number') return null
    return { runtime: runtime as RuntimeId, account, lane, resetsAt, threshold }
  } catch { return null }
}

/**
 * The allowance-crossing notices a newer read has superseded, by id: the window they named has reset, a newer read of
 * that account puts the window in another cycle or back under the line, or (for a notice from before crossings carried
 * their figures) any newer read exists, since what it said can no longer be checked. A notice with no read newer than
 * itself stays: nothing newer has said otherwise. Every other kind of notice is left alone.
 */
export const supersededUsageNotices = (
  entries: readonly { readonly id: string; readonly contentKey?: string; readonly kind?: string; readonly at?: number }[],
  reports: readonly UsageReport[],
  now: number,
): ReadonlySet<string> => {
  const read = reports.filter(report => !isSilentUsage(report))
  const gone = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== USAGE_CROSSING_KIND) continue
    const at = typeof entry.at === 'number' ? entry.at : 0
    const crossing = crossingOf(entry.contentKey ?? entry.id)
    if (!crossing) {
      if (read.some(report => report.fetchedAt > at)) gone.add(entry.id)
      continue
    }
    if (crossing.resetsAt !== null && crossing.resetsAt <= now) { gone.add(entry.id); continue }
    const newer = read.filter(report => report.runtime === crossing.runtime && (report.account?.trim() || null) === crossing.account && report.fetchedAt > at)
      .sort((a, b) => b.fetchedAt - a.fetchedAt)[0]
    const lane = newer?.lanes.find(one => one.id === crossing.lane && one.usageKnown !== false && one.placeholder !== true)
    if (!lane) continue
    if (lane.resetsAt !== crossing.resetsAt || lane.usedPercent < crossing.threshold) gone.add(entry.id)
  }
  return gone
}
