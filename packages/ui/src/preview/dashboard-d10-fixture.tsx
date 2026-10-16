import { createRoot } from 'react-dom/client'
import type { LedgerReport, UsageReport } from '@harnessdesk/protocol'
import { App } from '../app/App'
import { StoreProvider } from '../state/context'
import { dashboardDestinationStore } from './dashboard-destination-fixture'

/** Two signed-in plans: one below the sustainable line, one above it. */
export const dashboardD10Store = () => {
  const store = dashboardDestinationStore()
  const snapshot = store.getSnapshot()
  const now = Date.now()
  const runtimes = snapshot.runtimes.slice(0, 2).map((info, index) => ({ ...info,
    capabilities: { ...info.capabilities, account: true, metered: true },
    presentation: { ...info.presentation, name: index === 0 ? 'North' : 'South' },
  }))
  const usage: UsageReport[] = runtimes.map((info, index) => ({
    runtime: info.id, account: index === 0 ? 'dev@example.com' : 'analyst@example.com',
    plan: index === 0 ? 'self_serve_business_prolite' : 'pro',
    planLabel: index === 0 ? 'Business Pro Lite' : 'Pro',
    lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: index === 0 ? 89 : 11,
      windowMinutes: 10_080, resetsAt: now + 10_080 * 60_000 / 2, usageKnown: true }],
    credits: null, spend: null, reached: null,
    source: { kind: 'runtime', label: 'From a recorded plan' },
    fetchedAt: performance.timeOrigin - 3 * 3_600_000, staleAfterMs: 5 * 60_000, error: null,
  }))
  Object.assign(snapshot, { runtimes, usage,
    accountsByRuntime: Object.fromEntries(usage.map(report => [report.runtime, { accounts: [{ kind: 'plan', label: report.account }], signInMethods: [] }])),
  })
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method, params) => {
    if (method === 'usage/reports' || method === 'usage/refresh') return usage
    if (method === 'usage/ledger') {
      const report = await request(method, params as never) as LedgerReport
      const ids = new Set(runtimes.map(info => info.id))
      const rows = report.rows.filter(row => row.runtime !== null && ids.has(row.runtime))
      const daily = report.daily.filter(day => ids.has(day.runtime))
      return { ...report, rows, daily, totals: undefined,
        totalCost: rows.reduce((sum, row) => sum + (row.cost ?? 0), 0),
        totalTokens: rows.some(row => row.tokens === null) ? null : rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0),
        coverage: { ...report.coverage, turnsKnownFor: report.coverage.turnsKnownFor?.filter(id => ids.has(id)) } }
    }
    return request(method, params as never)
  }) as typeof store.transport.request
  return store
}

/** Browser checks mount this fixture inside preview.html, using only synthetic identities. */
export const mountDashboardD10 = (container: HTMLElement) => {
  const store = dashboardD10Store()
  createRoot(container).render(<StoreProvider store={store}><App /></StoreProvider>)
}
