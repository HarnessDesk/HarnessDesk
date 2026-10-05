import { NO_CAPABILITIES } from '@harnessdesk/protocol'

import { previewStore } from './harness'

/** Isolated Settings data: every changed list has rows to inspect, never a desk's accounts. */
export const capabilityListsStore = () => {
  const base = previewStore().getSnapshot()
  const own = previewStore({
    runtimes: base.runtimes.map(info => info.id === base.activeRuntime ? {
      ...info,
      capabilities: { ...NO_CAPABILITIES, ...info.capabilities, skills: true, hooks: true, mcp: true, extensionStore: true },
    } : info),
  })
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
    { name: 'Team notes', tools: ['read'], resources: 2, auth: 'oauth' },
  ]
  own.listCredentials = async () => [
    { ref: 'cred_r1', name: 'Team proxy key', createdAt: Date.UTC(2026, 8, 15), owner: { kind: 'endpoint' } },
  ]
  return own
}
