/** Synthetic ordinary conversations and a five-runtime install for D1 review. */
import { createRoot } from 'react-dom/client'
import { approvalId, runtimeId, turnId, type Library, type LedgerReport } from '@harnessdesk/protocol'
import { App } from '../app/App'
import { SignIn } from '../components/SignIn'
import { StoreProvider } from '../state/context'
import { emptyWorkbench } from '../state/workbench'
import { frameDestinationStore } from './frame-destination-store'
import { LIBRARY, PREVIEW_SESSION_KEY, previewStore } from './harness'
import '../styles/app.css'

const scene = new URLSearchParams(location.search).get('scene')
const fixture = previewStore()
const seed = fixture.getSnapshot()
const session = seed.sessions.get(PREVIEW_SESSION_KEY)!
const ordinary = { ...session, settings: { cwd: session.cwd, model: '', ...session.settings } }
delete ordinary.settings.agent
const plain = { ...ordinary, turns: [...ordinary.turns, {
  id: turnId('silent-runtime-turn'), items: [], status: 'completed' as const, diff: null,
}] }
fixture.patch({ sessions: new Map(seed.sessions).set(PREVIEW_SESSION_KEY, scene === 'transcript' ? plain : ordinary),
  activeSessionKey: PREVIEW_SESSION_KEY, goals: new Map(), approvals: scene === 'approval' ? [{
    key: PREVIEW_SESSION_KEY, approval: { id: approvalId('write-files'), sessionId: session.id,
      requestedAt: Date.now(), type: 'fileChange', changes: [], options: [
        { id: 'yes', label: 'Apply changes', intent: 'approve' }, { id: 'no', label: 'Decline', intent: 'deny' },
      ] },
  }] : [],
})
if (scene === 'library') {
  const base = seed.runtimes[0]!
  const ids = ['first', 'second', 'third', 'fourth', 'fifth'].map(runtimeId)
  fixture.patch({ runtimes: ids.map((id, n) => ({ ...base, id, name: `Runtime ${n + 1}`,
    presentation: { ...base.presentation, name: `Runtime ${n + 1}` } })) })
  const library: Library = { ...LIBRARY, home: '/workspace', runtimes: ids, locations: ids.map(id => ({
    runtime: id, kind: 'skill', path: `/workspace/.${id}/skills`, scope: 'user', scanned: true, exists: true, readOnly: false,
  })), entries: [{ ...LIBRARY.entries[0]!, kind: 'skill', name: 'checkout-review', copies: [{
    path: '/workspace/.first/skills/checkout-review', scope: 'user', readBy: [ids[0]!], hollow: false, digest: 'synthetic', readOnly: false,
  }], reach: ids.map((runtime, n) => ({ runtime, state: n === 0 ? 'reaches' : 'absent', basis: 'scanned' })) }], gaps: [] }
  const request = fixture.transport.request.bind(fixture.transport)
  fixture.transport.request = (async (method, params) => method === 'library/read' ? library : request(method, params as never)) as typeof fixture.transport.request
}
if (scene?.startsWith('usage')) {
  const [first, second] = seed.runtimes
  const day = new Date().setHours(0, 0, 0, 0)
  const ledger: LedgerReport = {
    days: 30, currency: 'USD', totalCost: 12, totalTokens: 100, provenance: 'listPrice', scannedAt: Date.now(),
    coverage: { priced: 1, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 1, daysRequested: 30, turnsKnownFor: [first!.id], hoursKnownFor: [first!.id] },
    rows: [{ key: 'first', label: first!.presentation.name, runtime: first!.id, cost: 12, tokens: 100, hasUnpriced: false },
      { key: 'second', label: second!.presentation.name, runtime: second!.id, cost: null, tokens: null, hasUnpriced: true }],
    daily: [{ day, runtime: first!.id, cost: 12, tokens: 100, turns: 3 }, { day, runtime: second!.id, cost: 0, tokens: 0 }],
    hourly: [{ weekday: new Date().getDay(), hour: 12, runtime: first!.id, tokens: 100, requests: 3 }],
  }
  fixture.ledger = async () => ledger
}
const extra = { ...seed.runtimes[0]!, id: runtimeId('additional-runtime'), slot: {
  agent: seed.runtimes[0]!.id, home: '/workspace/.additional-runtime', removable: true, canAdd: true, gateways: true as const,
} }
if (scene === 'sign-in') fixture.patch({ runtimes: [...seed.runtimes, extra], accountsByRuntime: {
  ...seed.accountsByRuntime, [extra.id]: seed.accountsByRuntime[seed.runtimes[0]!.id]!,
} })
const main = { root: { kind: 'pane' as const, id: 'runtime-copy-pane', view: { kind: 'conversation' as const, session: PREVIEW_SESSION_KEY } }, focused: 'runtime-copy-pane', expanded: null }
fixture.patch({ layout: main, workbench: { ...emptyWorkbench(), main } })
const store = frameDestinationStore(fixture)
if (scene === 'library') store.openDestination({ kind: 'library', section: 'skill' })
else if (scene?.startsWith('usage')) store.openDestination({ kind: 'dashboard', view: scene === 'usage-activity' ? 'activity' : 'overview', scope: null })
else if (scene === 'notifications') store.openDestination({ kind: 'settings', route: { kind: 'section', section: 'notifications', focus: null } })
createRoot(document.getElementById('root')!).render(<StoreProvider store={store}><App />{scene === 'sign-in' && <SignIn runtime={extra.id} onClose={() => {}} />}</StoreProvider>)
