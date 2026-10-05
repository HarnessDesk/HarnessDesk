import { NO_CAPABILITIES, type Library } from '@harnessdesk/protocol'

import { LIBRARY, previewStore, runtime } from './harness'
import previewMark from '../assets/brand/mark.svg?raw'

/** Isolated Settings data: every changed list has rows to inspect, never a desk's accounts. */
export const capabilityListsStore = (stress = false) => {
  const base = previewStore().getSnapshot()
  const own = previewStore({
    ...(stress ? { skills: base.skills.map((skill, index) => ({ ...skill,
      ...(index === 0 ? { iconUrl: `data:image/svg+xml,${encodeURIComponent(previewMark)}` } : {}),
      ...(index === 2 ? { iconUrl: 'data:image/png;base64,AA==' } : {}),
      ...(index === 1 ? { description: 'Explore requirements, constraints and the design before implementation. '.repeat(12) } : {}),
    })) } : {}),
    runtimes: [...base.runtimes, ...(stress ? [runtime('preview-delta', 'Delta')] : [])].map(info => info.id === base.activeRuntime ? {
      ...info,
      capabilities: { ...NO_CAPABILITIES, ...info.capabilities, skills: true, hooks: true, mcp: true, extensionStore: true },
    } : info),
  })
  if (stress) {
    const agents = own.getSnapshot().runtimes.map(info => info.id)
    const loaded = agents.map(id => ({ runtime: id, state: 'reaches' as const, basis: 'reported' as const }))
    const example = LIBRARY.entries[0]!
    const library: Library = {
      ...(LIBRARY as unknown as Library),
      home: '/home/u',
      runtimes: agents,
      entries: [
        ...LIBRARY.entries,
        { ...example, name: 'four-agents', title: 'Shared review', reach: loaded },
        { ...example, name: 'refused', reach: [{ ...loaded[0]!, state: 'rejected', note: 'Invalid metadata.' }, ...loaded.slice(1)] },
        { ...example, name: 'unloaded', copies: [], reach: agents.map(id => ({ runtime: id, state: 'absent', basis: 'scanned' })) },
      ],
    } as Library
    const request = own.transport.request.bind(own.transport)
    own.transport.request = async (method, params) => method === 'library/read' ? library : request(method, params)
  }
  own.loadHooks = async () => [
    { id: 'check', event: 'Before a tool runs', source: '~/.agents/hooks.json', trust: 'trusted', enabled: true, managed: false },
    { id: 'report', event: 'After work completes', source: '~/code/project/hooks.json', trust: 'modified', enabled: true, managed: false },
  ]
  own.loadCatalog = async () => ({
    plugins: [
      { id: 'docs', name: 'Project docs', category: 'Reference', description: 'Find project reference material.', installed: true, enabled: true },
      { id: 'checks', name: 'Project checks', category: 'Development', description: 'Run the project checks.', installed: true, enabled: false },
      { id: 'notes', name: 'Release notes', category: 'Writing', description: 'Draft release notes for the project.', installed: false, enabled: false },
      { id: 'connect', name: 'Team calendar', category: 'Planning', description: 'Read the team’s shared calendar.', installed: false, enabled: false, external: true, installUrl: 'https://acme.dev/connect' },
    ], marketplaces: [], loadErrors: [], featured: [],
  })
  own.loadMcpServers = async () => [
    { name: 'Workspace tools', tools: ['read', 'search'], resources: 3, auth: 'none' },
    { name: 'Project docs', tools: ['find'], resources: 0, auth: 'token' },
    { name: 'Team notes', tools: ['read'], resources: 1, auth: 'oauth' },
  ]
  own.listCredentials = async () => [
    { ref: 'cred_r1', name: 'Team proxy key', createdAt: Date.UTC(2026, 8, 15), owner: { kind: 'endpoint' } },
  ]
  return own
}
