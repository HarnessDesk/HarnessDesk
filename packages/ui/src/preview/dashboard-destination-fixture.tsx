import { useMemo } from 'react'
import type { HostMethodName, HostParams, InsightQuery, LedgerQuery, LedgerReport, RuntimeId, UsageReport } from '@harnessdesk/protocol'
import { App } from '../app/App'
import type { DashboardView } from '../components/Usage'
import { StoreProvider } from '../state/context'
import { frameDestinationStore } from './frame-destination-store'
import { usagePreviewStore } from './usage-fixture'

/** Lane-owned host answers around the real AppStore and App navigation. */
export const dashboardDestinationStore = ({ view = 'overview', scope = null, borrowed = false, emptyUsage = false, unpricedPaid = false, paced = false }: {
  readonly view?: DashboardView; readonly scope?: RuntimeId | null; readonly borrowed?: boolean; readonly emptyUsage?: boolean; readonly unpricedPaid?: boolean
  /** One account whose refresh failed after a good reading (#2094), and one whose Weekly refills tomorrow mostly unspent (Q15). */
  readonly paced?: boolean
} = {}) => {
  const fixture = usagePreviewStore(), store = frameDestinationStore(fixture)
  const snapshot = store.getSnapshot()
  if (paced) {
    const usage = pacedUsage(snapshot.usage, Date.now())
    Object.assign(snapshot, { usage })
    Object.assign(fixture.getSnapshot(), { usage })
  }
  if (emptyUsage) {
    Object.assign(snapshot, { usage: [] })
    Object.assign(fixture.getSnapshot(), { usage: [] })
  } else if (unpricedPaid && snapshot.usage[0]) {
    const report = snapshot.usage[0]
    const usage = [{ ...report, billing: { ...(report.billing ?? { kinds: [] }), fee: null } }]
    Object.assign(snapshot, { usage })
    Object.assign(fixture.getSnapshot(), { usage })
  }
  if (borrowed) {
    const source = snapshot.usage.find(report => (scope === null || report.runtime === scope) && report.lanes.length > 0)
    if (source) Object.assign(snapshot,{usage:snapshot.usage.map(report => report === source ? {
      ...report, lanes: [], unverified: { whose: 'other@example.com sign-in', lanes: source.lanes,
        reached: source.reached, fetchedAt: source.fetchedAt, staleAfterMs: source.staleAfterMs },
    } : report)})
  }
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: HostMethodName, params: HostParams<HostMethodName>) => {
    if (method === 'usage/reports' || method === 'usage/refresh') return snapshot.usage
    if (method === 'usage/ledger') {
      const query = params as LedgerQuery
      if (emptyUsage) return {
        days: query.days,
        currency: 'USD',
        totalCost: null,
        totalTokens: 0,
        provenance: 'unknown',
        coverage: { priced: 0, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 0, daysRequested: query.days },
        rows: [],
        daily: [],
        scannedAt: null,
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, turns: 0 },
      } satisfies LedgerReport
      const reading = await fixture.ledger(query) as LedgerReport
      if (!query.runtime) return reading
      const daily = reading.daily.filter(day => day.runtime === query.runtime)
      const rows = query.groupBy === 'project'
        ? [{key:snapshot.workspace?.path ?? '/work/storefront',label:'Storefront',runtime:query.runtime,
            cost:daily.reduce((sum,day)=>sum+day.cost,0),tokens:daily.reduce((sum,day)=>sum+day.tokens,0),hasUnpriced:false}]
        : reading.rows.filter(row=>row.runtime === query.runtime)
      return {...reading,daily,rows,totalCost:daily.reduce((sum,day)=>sum+day.cost,0),totalTokens:daily.reduce((sum,day)=>sum+day.tokens,0),
        totals:undefined,coverage:{...reading.coverage,turnsKnownFor:reading.coverage.turnsKnownFor?.filter(id=>id === query.runtime)}}
    }
    if (method === 'insight/usage') {
      const report = await fixture.readUsageInsight(params as InsightQuery)
      const latest = fixture.getSnapshot()
      Object.assign(store.getSnapshot(),{goals:latest.goals,flowExecutions:latest.flowExecutions})
      if (emptyUsage) {
        const unknown = (metric: typeof report.totals.usd) => ({ ...metric, value: null, quality: 'unknown' as const, coverage: 'none' as const, sourceIds: [], missing: [] })
        return {
          ...report,
          totals: { usd: unknown(report.totals.usd), tokens: unknown(report.totals.tokens), turns: unknown(report.totals.turns), activeMs: unknown(report.totals.activeMs) },
          recordedSpend: [], seats: [], goals: [],
          breakdowns: [],
          sources: [],
          gaps: [],
        }
      }
      return report
    }
    return request(method,params as never)
  }) as typeof store.transport.request
  store.openDestination({kind:'dashboard',view,scope})
  return store
}
/**
 * The kept reading and the pacing note on the preview's own accounts: the first account of the second agent keeps its
 * figures from 25 minutes ago after a refresh failed (#2094), and the first account's Weekly refills in 20 hours with
 * 70% of it unspent, so the Overview leads with "Use … first" (Q15).
 */
export const pacedUsage = (usage: readonly UsageReport[], now: number): UsageReport[] => {
  const failed = usage.findIndex((report) => report.runtime !== usage[0]?.runtime && report.lanes.length > 0)
  return usage.map((report, at) => at === failed
    ? { ...report, fetchedAt: now - 25 * 60_000, error: { message: 'The provider did not answer' } }
    : at === 0
      ? { ...report, fetchedAt: now - 60_000, lanes: report.lanes.map((lane) => lane.id === 'weekly' ? { ...lane, usedPercent: 30, resetsAt: now + 20 * 3_600_000 } : lane) }
      : report)
}
/** Task 9 can mount this fixture without introducing a second route state. */
export const DashboardDestinationFixture = (input: {readonly view?:DashboardView;readonly scope?:RuntimeId|null;readonly borrowed?:boolean;readonly emptyUsage?:boolean;readonly unpricedPaid?:boolean;readonly paced?:boolean}) => {
  const store=useMemo(()=>dashboardDestinationStore(input),[input.view,input.scope,input.borrowed,input.emptyUsage,input.unpricedPaid,input.paced])
  return <StoreProvider store={store}><App /></StoreProvider>
}
