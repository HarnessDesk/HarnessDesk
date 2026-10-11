import type { HostMethodName, HostParams } from '@harnessdesk/protocol'
import { App } from '../app/App'
import { StoreProvider } from '../state/context'
import { emptyWorkbench } from '../state/workbench'
import { AppStore } from '../state/store'
import { frameDestinationStore } from './frame-destination-store'
import { framePageRoute, framePageIds } from './frame-page-route'
import { PREVIEW_AGENTS, PREVIEW_SESSION_KEY, previewStore } from './harness'
import '../styles/app.css'

/** E4's isolated preview entry. Integration uses the same routes in FrameWall. */
export const agentsDestinationStore = (query: URLSearchParams): AppStore => {
  const fixture = previewStore()
  const main = { root: { kind: 'pane' as const, id: 'e4-work', view: { kind: 'conversation' as const, session: PREVIEW_SESSION_KEY } }, focused: 'e4-work', expanded: null }
  Object.assign(fixture.getSnapshot(), { workbench: { ...emptyWorkbench(), main }, layout: main,
    activeSessionKey: PREVIEW_SESSION_KEY, sidebarCollapsed: false, sidebarFloating: false })
  if (query.get('frame-agent-case') === 'refused') {
    const snapshot = fixture.getSnapshot(), plan = snapshot.agentPlans.get('code-reviewer')!
    Object.assign(snapshot, { agentPlans: new Map(snapshot.agentPlans).set('code-reviewer', {
      ...plan, from: 'prefer', winner: null, ceiling: null, candidates: [plan.candidates[0]!], own: [],
    }), seating: { ...snapshot.seating!, entries: snapshot.seating!.entries.filter(entry => entry.id !== 'code-reviewer') } })
  }
  const store = frameDestinationStore(fixture)
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: HostMethodName, params: HostParams<HostMethodName>) => {
    const target = params as { id: string; origin: 'project' | 'user' | 'builtin'; target: Parameters<AppStore['readAuthoring']>[0]; ids: readonly string[] }
    if (method === 'insight/agent') {
      const query = params as HostParams<'insight/agent'>
      return fixture.readAgentInsight(query.root, query.agent, query.origin)
    }
    if (method === 'authoring/read') return fixture.readAuthoring(target.target)
    if (method === 'authoring/save/pending') return fixture.authoringPending()
    if (method === 'attachment/agent') return fixture.readAgentAttachments(target.id, target.origin)
    if (method === 'attachment/notes') return fixture.readAgentNotes(target.id, target.origin)
    if (method === 'agent/seat/dry') return target.ids.map(id => fixture.getSnapshot().agentPlans.get(id)).filter(Boolean)
    if (method === 'agent/seating/read') return fixture.getSnapshot().seating
    return request(method, params as never)
  }) as typeof store.transport.request
  const selected = query.get('frame-agent-case')
  const route = selected === 'missing' ? { kind: 'agents' as const, id: 'missing-agent' }
    : selected === 'parse' ? { kind: 'agents' as const, id: 'draft' }
    : selected === 'refused' ? { kind: 'agents' as const, id: 'code-reviewer' }
    : framePageRoute(query, { ...framePageIds(store.getSnapshot()), agent: PREVIEW_AGENTS.find(entry => entry.id === 'code-reviewer')!.id })
  // Start with recorded work behind the page; navigation remains the real store's.
  if (route) store.openDestination(route)
  return store
}

export const AgentsDestinationFixture = ({ store }: { readonly store: AppStore }) =>
  <StoreProvider store={store}><App /></StoreProvider>
