import type { RuntimeId } from './ids.js'
import { usageStandingOf, type UsageReport } from './usage.js'


/**
 * The accounts every usage surface lists, the Dashboard, the Runtimes page, the phone and the Lead's summary alike:
 * each reading of an agent the person tracks, and for a tracked agent with none, one entry that says it is not
 * reporting. A reading of an agent the person stopped tracking, or of one no longer on the desk, is not listed.
 * Reading order is kept: tracked agents with readings first in the order given, then the silent ones in roster order.
 *
 * "Not reporting" is a claim about an answer, so it is made only for an agent `asked` says was read since the desk
 * started. Right after a start nothing has been asked yet; an agent with no reading then is left out until its first
 * read finishes, rather than called silent because a cache is empty.
 */
export const trackedUsage = (
  runtimes: readonly { readonly id: RuntimeId }[],
  reports: readonly UsageReport[],
  off: readonly RuntimeId[],
  now: number,
  asked: (runtime: RuntimeId) => boolean = () => true,
): readonly UsageReport[] => {
  const skip = new Set(off), known = new Set(runtimes.map(info => info.id))
  const metered = reports.filter(report => known.has(report.runtime) && !skip.has(report.runtime) && report.notReporting !== true)
  const read = new Set(metered.map(report => report.runtime))
  const silent = runtimes.filter(info => !skip.has(info.id) && !read.has(info.id) && asked(info.id)).map((info): UsageReport => ({
    runtime: info.id, account: null, plan: null, lanes: [], credits: null, spend: null, reached: null,
    source: { kind: 'runtime', label: 'no source available' }, fetchedAt: now, staleAfterMs: Number.POSITIVE_INFINITY, error: null, notReporting: true,
  }))
  return [...metered, ...silent]
}

/** Whether an entry is the stand-in for a tracked agent nothing has read. */
export const isSilentUsage = (report: UsageReport): boolean => report.notReporting === true

/** The five shapes `UsageBilling.kinds` names, in the order a primary shape is chosen. */
export type UsagePlanShape = 'windows' | 'allowance' | 'balance' | 'metered' | 'free'
/** An account's shape, plus the one case no `UsageBilling` value can express: nothing to show. */
export type UsageShape = UsagePlanShape | 'none'
const SHAPE_ORDER: readonly UsagePlanShape[] = ['windows', 'allowance', 'balance', 'metered', 'free']

/**
 * An account's primary shape: the first of `billing.kinds` in the fixed order windows → allowance → balance →
 * metered → free. A report with no `billing` but real lanes or a real balance still has a shape, the one those facts
 * would have named. Only a report with none of `billing`, `lanes` or a finite balance is `'none'`.
 */
export const usageShapeOf = (report: UsageReport): UsageShape => {
  const kinds = report.billing?.kinds ?? []
  for (const shape of SHAPE_ORDER) if (kinds.includes(shape)) return shape
  if (report.lanes.length > 0) return 'windows'
  const remaining = report.credits?.remaining
  if (typeof remaining === 'number' && Number.isFinite(remaining)) return 'balance'
  return 'none'
}

/**
 * An account that answered, but with nothing any surface can draw: no shape of its own, no other sign-in's figures
 * beside it, and nothing failed or spent. The Plans table lists it as "plan usage unavailable · Not reporting", and
 * the phone and the Lead say Not reporting for it too, never Unknown or Ready. A failed read with nothing kept is
 * Unknown instead, as everywhere.
 */
export const answeredWithNothing = (report: UsageReport, now: number): boolean =>
  !isSilentUsage(report) && usageShapeOf(report) === 'none' && (report.unverified?.lanes.length ?? 0) === 0 &&
  usageStandingOf(report, now).status === 'ready'

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
 * Whose a notice from before crossings carried their figures is: the agent its text opens with ("<name> — …", or
 * "<name> · <account> — …"), by the longest name that fits. Null when no agent's name fits, or two agents share it.
 */
const legacyOwner = (title: string | undefined, names: ReadonlyMap<RuntimeId, string>): RuntimeId | null => {
  const head = title?.split(' — ')[0]?.trim()
  if (!head) return null
  const fits = [...names].filter(([, name]) => name && (head === name || head.startsWith(`${name} `)))
  const longest = Math.max(-1, ...fits.map(([, name]) => name.length))
  const owners = fits.filter(([, name]) => name.length === longest)
  return owners.length === 1 ? owners[0]![0] : null
}

/**
 * The allowance-crossing notices a newer read has superseded, by id: the window they named has reset, or a newer read
 * of that account puts the window in another cycle or back under the line. A notice from before crossings carried
 * their figures cannot be checked; it leaves only once every account of its own agent (named in its text, matched
 * against `names`) has been read since, and stays when the agent cannot be told. A notice with no read newer than
 * itself stays: nothing newer has said otherwise. Every other kind of notice is left alone.
 */
export const supersededUsageNotices = (
  entries: readonly { readonly id: string; readonly contentKey?: string; readonly kind?: string; readonly at?: number; readonly title?: string }[],
  reports: readonly UsageReport[],
  now: number,
  names: ReadonlyMap<RuntimeId, string> = new Map(),
): ReadonlySet<string> => {
  const read = reports.filter(report => !isSilentUsage(report))
  const gone = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== USAGE_CROSSING_KIND) continue
    const at = typeof entry.at === 'number' ? entry.at : 0
    const crossing = crossingOf(entry.contentKey ?? entry.id)
    if (!crossing) {
      const owner = legacyOwner(entry.title, names), own = owner ? read.filter(report => report.runtime === owner) : []
      if (own.length > 0 && own.every(report => report.fetchedAt > at)) gone.add(entry.id)
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
