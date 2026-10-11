import { useMemo } from 'react'
import type { HostMethodName, HostParams, InsightQuery, LedgerQuery, LedgerReport, RuntimeId } from '@harnessdesk/protocol'
import { App } from '../app/App'
import type { DashboardView } from '../components/Usage'
import { StoreProvider } from '../state/context'
import { frameDestinationStore } from './frame-destination-store'
import { usagePreviewStore } from './usage-fixture'

/** Lane-owned host answers around the real AppStore and App navigation. */
export const dashboardDestinationStore = ({ view = 'overview', scope = null, borrowed = false }: {
  readonly view?: DashboardView; readonly scope?: RuntimeId | null; readonly borrowed?: boolean
} = {}) => {
  const fixture = usagePreviewStore(), store = frameDestinationStore(fixture)
  const snapshot = store.getSnapshot()
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
      Object.assign(snapshot,{goals:latest.goals,flowExecutions:latest.flowExecutions})
      return report
    }
    return request(method,params as never)
  }) as typeof store.transport.request
  store.openDestination({kind:'dashboard',view,scope})
  return store
}
/** Task 9 can mount this fixture without introducing a second route state. */
export const DashboardDestinationFixture = (input: {readonly view?:DashboardView;readonly scope?:RuntimeId|null;readonly borrowed?:boolean}) => {
  const store=useMemo(()=>dashboardDestinationStore(input),[input.view,input.scope,input.borrowed])
  return <StoreProvider store={store}><App /></StoreProvider>
}
