import { DEFAULT_LANE_PREFERENCES } from '@harnessdesk/protocol'
import type { TransportEvents } from '../lib/transport'
import { AppStore, type AppSnapshot } from '../state/store'
import type { HostMethodName, HostParams, RuntimeId, SessionId } from '@harnessdesk/protocol'
import { sessionKey } from '@harnessdesk/protocol'
import { focusedPane } from '../state/layout'
import { destinationOf } from '../state/destinations'
export const frameDestinationStore = (fixture: AppStore): AppStore => {
  const store = new AppStore('ws://localhost:0/')
  const seed: AppSnapshot = fixture.getSnapshot()
  const view = focusedPane(seed.layout).view
  const current = destinationOf(view.kind === 'conversation' || view.kind === 'room' ? view : { kind: 'conversation', session: null })
  Object.assign(store.getSnapshot(), seed, { workbench: { ...seed.workbench, navigation: { current, back: [], forward: [] } } })
  const fixtureRequest = fixture.transport.request.bind(fixture.transport)
  store.transport.request = (async (method: HostMethodName, params: HostParams<HostMethodName>) => {
    if (method === 'session/read' || method === 'session/resume') {
      const query = params as { runtime: RuntimeId; sessionId: SessionId }
      const session = seed.sessions.get(sessionKey(query.runtime, query.sessionId))
      if (!session) throw new Error('Synthetic session is unavailable')
      return session
    }
    if (method === 'app/state/get') return {}
    if (method === 'app/state/set') return {}
    const query = params as { runtime: RuntimeId; root: string; project: string; account: string; plan?: string|null }
    if (method === 'runtime/account') return seed.accountsByRuntime[query.runtime] ?? {accounts:[],signInMethods:[]}
    if (method === 'runtime/resources') return fixture.runtimeResources()
    if (method === 'runtime/health') return fixture.healthFor(query.runtime)
    if (method === 'runtime/limits') return fixture.limitsFor(query.runtime)
    if (method === 'runtime/options') return fixture.optionsFor(query.runtime)
    if (method === 'runtime/sessionDefaults') return fixture.newSessionDefaultsFor(query.runtime)
    if (method === 'usage/plan/read') return fixture.readPlan(query)
    if (method === 'acp/catalog') return fixture.agentCatalog()
    if (method === 'acp/registry') return fixture.acpRegistry()
    if (method === 'agent/list') return fixture.agentsIn(query.project)
    if (method === 'flow/catalog') return fixture.flowCatalog(query.root)
    if (method === 'evidence/checks') return fixture.projectChecks(query.project)
    if (method === 'trigger/list') return fixture.projectTriggers(query.root)
    if (method === 'lane/preferences') return seed.lanePreferences ?? DEFAULT_LANE_PREFERENCES
    if (method === 'lane/list') return seed.lanes
    if (method === 'trigger/preferences') return fixture.triggerPreferences()
    if (method === 'history/status') return seed.historyImports[query.runtime] ?? null
    if (method === 'history/list') return {data:[],nextCursor:null}
    if (method === 'credentials/list' || method === 'runtime/hooks' || method === 'runtime/mcp/list' || method === 'provenance/status') return []
    if (method === 'runtime/catalog') return {plugins:[],marketplaces:[],loadErrors:[],featured:[]}
    if (method === 'runtime/apps/search') return {apps:[]}
    if (method === 'worktree/list') return seed.worktrees
    if (method === 'runtime/installs') return null
    if (method === 'runtime/warm') return {ready:true}
    if (method === 'terminal/open') return {terminalId:'frame-pty',runtime:seed.activeRuntime}
    const reading = await fixtureRequest(method, params as never)
    if (reading !== null && reading !== undefined) return reading
    if (method === 'storage/usage') return {database:{bytes:148*1024**2,computing:false},snapshots:{count:3,bytes:420*1024**2,computing:false},cachedPreviews:{count:18,bytes:86*1024**2},worktrees:{count:24,bytes:8.6*1024**3,kept:0,computing:false}}
    if (method === 'storage/kept') return []
    if (method === 'terminal/write' || method === 'terminal/resize' || method === 'terminal/close') return null
    throw new Error(`Synthetic page fixture has no answer for ${method}`)
  }) as typeof store.transport.request
  return store
}

/** Fixture event only: publish connection state through the real store's snapshot wake. */
export const setFrameConnection = (store: AppStore,status: AppSnapshot['status']): void => {
  ;(store.transport as unknown as {handlers:TransportEvents}).handlers.onStatus(status)
}
