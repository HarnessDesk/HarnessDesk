import type { AppSnapshot } from '../state/store'
import { accountKey } from '../lib/accounts'
import type { RuntimeId } from '@harnessdesk/protocol'
import type { PageDestination } from '../state/destinations'
import { destinationForSettings } from '../app/settings-destination'
export interface FramePageIds { readonly agent: string; readonly plugin: string; readonly runtime: RuntimeId; readonly account: string; readonly project: string; readonly skill: string }
export const framePageRoute = (query: URLSearchParams, ids: FramePageIds): PageDestination | null => {
  const kind = query.get('frame-wall')
  if (kind === 'settings') {
    const detail = query.get('frame-detail')
    if (detail === 'runtime') return { kind, route: { kind: 'runtime', runtime: ids.runtime } }
    if (detail === 'account') return { kind, route: { kind: 'account', runtime: ids.runtime, key: ids.account } }
    if (detail === 'project') return { kind, route: { kind: 'project', root: ids.project } }
    if (detail === 'skill') return { kind, route: { kind: 'skill', name: ids.skill } }
    return destinationForSettings(query.get('frame-section') ?? 'general', query.get('frame-focus'))
  }
  if (kind === 'dashboard') {
    const value = query.get('frame-view')
    const view = value === 'plans' || value === 'spend' || value === 'activity' || value === 'projects' ? value : 'overview'
    return { kind, view, scope: query.get('frame-scope') === 'runtime' ? ids.runtime : null }
  }
  if (kind === 'agents') return { kind, id: query.get('frame-detail') === 'agent' ? ids.agent : null }
  if (kind === 'teams') {
    const value = query.get('frame-filter')
    return { kind, filter: value === 'needs-you' || value === 'settled' ? value : 'active' }
  }
  if (kind === 'library') return { kind, section: query.get('frame-kind') === 'changes' ? 'changes' : query.get('frame-kind') === 'mcp' ? 'mcp' : 'skill' }
  if (kind === 'plugins') {
    const value = query.get('frame-plugin-page')
    return { kind, section: value === 'capabilities' ? 'capabilities' : 'installed', id: value === 'detail' ? ids.plugin : null }
  }
  return null
}

export const framePageIds = (snapshot: AppSnapshot): FramePageIds => {
  const runtime = snapshot.runtimes.find(info => (snapshot.accountsByRuntime[info.id]?.accounts.length ?? 0) > 0)
  const account = runtime ? snapshot.accountsByRuntime[runtime.id]?.accounts[0] : undefined
  const agent = snapshot.agents?.find(entry => entry.definition !== null)
  const plugin = snapshot.plugins[0], skill = snapshot.skills[0], project = snapshot.workspace?.path
  if (!runtime || !account || !agent || !plugin || !skill || !project) throw new Error('The page wall requires its complete synthetic fixture')
  return { agent: agent.id, plugin: plugin.instanceId, runtime: runtime.id, account: accountKey(runtime.id, account), project, skill: skill.name }
}
