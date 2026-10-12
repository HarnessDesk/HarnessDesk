import { DEFAULT_TRIGGER_BUDGET, type HostMethodName, type HostParams, type TriggerDefinition } from '@harnessdesk/protocol'
import { App } from '../app/App'
import { StoreProvider } from '../state/context'
import { emptyWorkbench } from '../state/workbench'
import { AppStore } from '../state/store'
import { frameDestinationStore } from './frame-destination-store'
import { framePageRoute, framePageIds } from './frame-page-route'
import { PREVIEW_AGENTS, PREVIEW_SESSION_KEY, previewStore } from './harness'
import { PREVIEW_ROOT } from './sidebar-fixture'
import '../styles/app.css'

/** E4's isolated preview entry. Integration uses the same routes in FrameWall. */
export const agentsDestinationStore = (query: URLSearchParams): AppStore => {
  const fixture = previewStore()
  const snapshot = fixture.getSnapshot()
  const storefront = '/work/storefront'
  Object.assign(snapshot, {
    workspace: snapshot.workspace ? { ...snapshot.workspace, path: storefront, checkoutRoot: storefront, name: 'storefront' } : null,
    agentsProject: storefront,
    agents: snapshot.agents?.map(entry => entry.origin === 'project'
      ? { ...entry, path: entry.path.replace(PREVIEW_ROOT, storefront) }
      : entry),
  })
  if (query.get('frame-agent-path') === 'long') {
    Object.assign(snapshot, {
      stateDir: '/private/tmp/synthetic-agent-fixture/isolated/worker/worktrees/round-four/app-frame-fix4-lists4/shared-home/profile/.harnessdesk',
    })
  }
  const main = { root: { kind: 'pane' as const, id: 'e4-work', view: { kind: 'conversation' as const, session: PREVIEW_SESSION_KEY } }, focused: 'e4-work', expanded: null }
  Object.assign(fixture.getSnapshot(), { workbench: { ...emptyWorkbench(), main }, layout: main,
    activeSessionKey: PREVIEW_SESSION_KEY, sidebarCollapsed: false, sidebarFloating: false })
  if (query.get('frame-agent-case') === 'refused') {
    const snapshot = fixture.getSnapshot(), plan = snapshot.agentPlans.get('code-reviewer')!
    Object.assign(snapshot, { agentPlans: new Map(snapshot.agentPlans).set('code-reviewer', {
      ...plan, from: 'prefer', winner: null, ceiling: null, candidates: [plan.candidates[0]!], own: [],
    }), seating: { ...snapshot.seating!, entries: snapshot.seating!.entries.filter(entry => entry.id !== 'code-reviewer') } })
  }
  if (query.get('frame-agent-case') === 'local-seat-mismatch') {
    const plan = snapshot.agentPlans.get('code-reviewer')!
    const machineSeat = { runtime: 'runtime-gamma' }
    const release = snapshot.agents?.find(one => one.id === 'release-checker')
    const secondLegacy = release?.definition ? {
      ...release,
      id: 'fixture-second-checker',
      path: '/private/tmp/synthetic-agent-fixture/isolated/worker/worktrees/round-four/shared-home/.harnessdesk/agents/second-checker/AGENT.md',
      digest: 'synthetic-second-checker',
      definition: {
        ...release.definition,
        id: 'fixture-second-checker',
        name: 'Second checker',
        description: 'Checks the same change from a separate synthetic brief.',
        ceiling: 'publish' as const,
        ceilingFrom: 'permission' as const,
      },
    } : null
    Object.assign(snapshot, {
      agents: snapshot.agents?.map(one => one.id === 'code-reviewer' && one.definition
        ? { ...one, definition: { ...one.definition, ceiling: 'edit', ceilingFrom: 'permission', prefer: [{ runtime: 'runtime-alpha' }] } }
        : one.id === 'release-checker' && one.definition
          ? { ...one, definition: { ...one.definition, ceiling: 'publish', ceilingFrom: 'permission' } }
        : one),
      agentPlans: new Map(snapshot.agentPlans).set('code-reviewer', {
        ...plan,
        from: 'machine',
        winner: 0,
        candidates: [{
          seat: machineSeat,
          label: 'Gamma',
          runtimeName: 'Gamma',
          state: 'passed' as const,
          reason: { kind: 'signedOut' as const },
          fix: { kind: 'signIn' as const, runtime: 'runtime-gamma' },
        }],
        own: [{ seat: { runtime: 'runtime-alpha' }, label: 'Alpha', runtimeName: 'Alpha', state: 'taken' as const, reason: null, fix: null }],
      }),
      seating: {
        ...snapshot.seating!,
        entries: [
          ...snapshot.seating!.entries.filter(one => one.id !== 'code-reviewer'),
          { id: 'code-reviewer', seats: [machineSeat] },
        ],
      },
    })
    if (secondLegacy && snapshot.agents) Object.assign(snapshot, { agents: [...snapshot.agents, secondLegacy] })
  }
  if (query.get('frame-agent-case') === 'release') {
    const plan = snapshot.agentPlans.get('release-checker')!
    const candidates = plan.candidates.map((candidate, index) => index === plan.winner
      ? { ...candidate, seat: { ...candidate.seat, runtime: 'preview-unbranded' as typeof candidate.seat.runtime }, runtimeName: 'Local seat' }
      : candidate)
    Object.assign(snapshot, { agentPlans: new Map(snapshot.agentPlans).set('release-checker', { ...plan, candidates }) })
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
    if (method === 'authoring/triggers/draft') {
      const draft = params as HostParams<'authoring/triggers/draft'>
      const definition: TriggerDefinition = {
        id: draft.id,
        on: draft.on === 'issue'
          ? { kind: 'issue', events: ['labelled', 'closed', 'commented'] }
          : draft.on === 'schedule'
            ? { kind: 'schedule', events: ['tick'], everyMinutes: 60 }
            : { kind: 'pull-request', events: ['opened', 'pushed'] },
        opens: draft.opens,
        goal: ['pr'],
        again: null,
        dedupe: ['pr', 'head', 'event'],
        concurrency: 1,
        forks: 'never',
        budget: DEFAULT_TRIGGER_BUDGET,
      }
      return definition
    }
    if (method === 'authoring/triggers/render') {
      const { definitions } = params as HostParams<'authoring/triggers/render'>
      return { source: JSON.stringify(definitions), issues: [] }
    }
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
    : selected === 'release-checker' ? { kind: 'agents' as const, id: 'release-checker' }
    : framePageRoute(query, { ...framePageIds(store.getSnapshot()), agent: selected === 'release' ? 'release-checker' : PREVIEW_AGENTS.find(entry => entry.id === 'code-reviewer')!.id })
  // Start with recorded work behind the page; navigation remains the real store's.
  if (route) store.openDestination(route)
  return store
}

export const AgentsDestinationFixture = ({ store }: { readonly store: AppStore }) =>
  <StoreProvider store={store}><App /></StoreProvider>
