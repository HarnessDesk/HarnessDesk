import { createRoot } from 'react-dom/client'
import type { LedgerReport } from '@harnessdesk/protocol'
import { App } from '../app/App'
import { StoreProvider } from '../state/context'
import { dashboardDestinationStore } from './dashboard-destination-fixture'
import { frameDestinationStore } from './frame-destination-store'
import { previewStore } from './harness'

/** Placeholder-only scenes for the three small-polish regressions. */
export const mountIssue1634 = (host: HTMLElement, scene: 'signin' | 'overview' | 'plans') => {
  const seed = previewStore()
  const base = seed.getSnapshot()
  const info = base.runtimes[0]!
  const account = { accounts: [], signInMethods: [{ id: 'browser', label: 'Sign in', flow: 'browser' as const }] }
  const store = scene === 'signin' ? frameDestinationStore(previewStore({
    runtimes: [{ ...info, presentation: { ...info.presentation, name: 'Alpha' }, capabilities: { ...info.capabilities, account: true } }],
    activeRuntime: info.id, account, accountsByRuntime: { [info.id]: account },
    health: { state: 'ready' }, healthByRuntime: { [info.id]: { state: 'ready' } },
    usage: [], limits: null, sessions: new Map(), activeSessionKey: null,
    history: [], teams: new Map(), goals: new Map(),
  })) : dashboardDestinationStore({ view: scene })
  const snapshot = store.getSnapshot()
  if (scene === 'signin') store.newDraft()
  else {
    const first = snapshot.usage.find(report => report.lanes.length > 0)!
    const usage = [{ ...first, account: 'dev@example.com', lanes: [{ ...first.lanes[0]!, id: 'weekly', label: 'Weekly', scope: undefined, windowMinutes: 10080, usedPercent: 25 }] }]
    Object.assign(snapshot, { usage })
    const request = store.transport.request.bind(store.transport)
    store.transport.request = (async (method, params) => {
      if (method === 'usage/reports' || method === 'usage/refresh') return usage
      const answer = await request(method, params as never)
      if (method !== 'usage/ledger') return answer
      const ledger = answer as LedgerReport
      return { ...ledger, totals: ledger.totals ? { ...ledger.totals, turns: undefined } : undefined,
        rows: ledger.rows.map(row => ({ ...row, turns: undefined })),
        daily: ledger.daily.map(day => ({ ...day, turns: undefined })),
        coverage: { ...ledger.coverage, turnsKnownFor: [] } }
    }) as typeof store.transport.request
  }
  createRoot(host).render(<StoreProvider store={store}><App /></StoreProvider>)
}
