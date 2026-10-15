import { useMemo } from 'react'
import type { AuthoringDocument, FlowPolicy, HostParams } from '@harnessdesk/protocol'
import { App } from '../app/App'
import { FrontDoor } from '../components/FrontDoor'
import { StoreProvider } from '../state/context'
import { frameDestinationStore } from './frame-destination-store'
import { teamStartStore } from './frames-team-start'
import { TEAM_START_POLICIES, TEAM_START_SOURCES } from './team-start-fixture'
import type { AppStore } from '../state/store'

const ROOT = '/work/storefront'

/** The real destination and editor, with synthetic files and local-only authoring answers. */
export const flowsDestinationStore = (): AppStore => {
  const fixture = teamStartStore()
  const policies = new Map<string, FlowPolicy>(Object.entries(TEAM_START_POLICIES))
  const sources = new Map(Object.entries(TEAM_START_SOURCES))
  let pendingSave: HostParams<'authoring/save/preview'> | null = null
  const lookup = new Proxy(fixture, { get(target, key, receiver) {
    if (key === 'flowCatalog') return async () => (await fixture.flowCatalog(ROOT)).map(entry => ({ ...entry, policy: policies.get(entry.id) ?? null }))
    if (key === 'readAuthoring') return async (target: Parameters<AppStore['readAuthoring']>[0]): Promise<AuthoringDocument> => ({
      target, source: target.kind === 'flow' ? sources.get(target.id) ?? '' : '', digest: '0'.repeat(64), exists: true,
      displayPath: target.kind === 'flow' ? `${target.id}.yml` : 'triggers.yml', writable: target.origin !== 'builtin', issues: [],
    })
    const value = Reflect.get(target, key, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const store = frameDestinationStore(lookup)
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method, params) => {
    if (method === 'flow/source') return fixture.flowSource(ROOT, (params as HostParams<'flow/source'>).id)
    if (method === 'authoring/shape/render') return fixture.renderShape((params as HostParams<'authoring/shape/render'>).policy)
    if (method === 'authoring/start/preview') return fixture.previewFrontDoor(params as HostParams<'authoring/start/preview'>)
    if (method === 'authoring/save/preview') {
      const input = params as HostParams<'authoring/save/preview'>
      pendingSave = input
      return { token: 'preview-flow-save', edits: [{ path: input.target.kind === 'flow' ? `flows/${input.target.id}.yml` : 'triggers.yml', before: input.target.kind === 'flow' ? sources.get(input.target.id) ?? null : null, after: input.source }], issues: [], resuming: false } // hd-secrets-ok: invented preview token.
    }
    if (method === 'authoring/save/apply' && pendingSave) {
      const input = pendingSave
      pendingSave = null
      if (input.target.kind === 'flow') {
        sources.set(input.target.id, input.source)
        if (input.source.startsWith('{')) policies.set(input.target.id, JSON.parse(input.source) as FlowPolicy)
      }
      return { state: 'applied', written: [input.target.kind === 'flow' ? `.harnessdesk/flows/${input.target.id}.yml` : '.harnessdesk/triggers.yml'], message: 'Saved.' }
    }
    return request(method, params as never)
  }) as typeof store.transport.request
  return store
}

export const FlowsDestinationFixture = () => {
  const scene = new URLSearchParams(location.search).get('flows-page')
  const store = useMemo(() => {
    const next = flowsDestinationStore()
    next.openDestination(scene === 'editor' ? { kind: 'flows', root: ROOT, id: 'fix-and-review', origin: 'builtin' }
      : scene === 'draft' ? { kind: 'flows', root: ROOT, id: null, origin: null }
        : { kind: 'flows', root: null, id: null, origin: null })
    return next
  }, [scene])
  return <StoreProvider store={store}><div className="h-screen" data-frame-id="flows-page"><App />
    {scene === 'new-team' && <FrontDoor context={{ kind: 'project', root: ROOT }} initial={{ id: 'fix-and-review', origin: 'builtin' }} initialTask="Fix the checkout retry and verify the change" onClose={() => {}} onStarted={() => {}} />}
  </div></StoreProvider>
}
