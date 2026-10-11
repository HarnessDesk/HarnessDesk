import { frameDestinationStore } from './frame-destination-store'
import { previewStore } from './harness'
import { framePageIds, framePageRoute } from './frame-page-route'

/** Synthetic plugin states served through the shared App destination. */
export const pluginsDestinationStore = (query: URLSearchParams) => {
const fixture = previewStore()
const snapshot = fixture.getSnapshot()
const first = snapshot.plugins[0]!
const configured = { ...first, configSchema: { type: 'object', properties: {
  greeting: { type: 'string', title: 'Greeting', default: 'Ready to help' },
  enabled: { type: 'boolean', title: 'Include context', default: true },
} }, config: { greeting: 'Ready to help' } }
const failed = { ...first, instanceId: 'fixture-failed' as typeof first.instanceId,
  identity: { ...first.identity, id: 'fixture-failed', name: 'Unavailable helper', source: { kind: 'local' as const, path: '/work/plugins/sample' } },
  state: { type: 'failed' as const, message: 'Synthetic manifest could not be loaded.' } }
Object.assign(snapshot, { plugins: [configured, ...snapshot.plugins.slice(1), failed] })
const store = frameDestinationStore(fixture)
const request = store.transport.request.bind(store.transport)
store.transport.request = (async (method, params) => {
  if (method === 'capability/list') {
    if (query.get('frame-plugin-pending') === '1') return new Promise(() => {})
    return snapshot.contributions.filter(contribution => contribution.kind === (params as { kind: string }).kind)
  }
  if (method === 'plugin/inspect') return { id: 'sample', name: 'Sample plugin', permissions: ['Read workspace files'], alreadyInstalled: false }
  if (method === 'plugin/list') return snapshot.plugins
  if (method === 'plugin/install' || method === 'plugin/configure' || method === 'plugin/setEnabled' || method === 'plugin/uninstall') return undefined
  return request(method, params as never)
}) as typeof store.transport.request
const route = framePageRoute(query, framePageIds(snapshot))
if (route) store.openDestination(query.get('frame-plugin-page') === 'failed'
  ? { kind: 'plugins', section: 'installed', id: failed.instanceId } : route)
return store
}