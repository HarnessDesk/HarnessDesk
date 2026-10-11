import { runtimeId, type Library, type LibraryEntry, type RuntimeInfo } from '@harnessdesk/protocol'

import type { AppStore } from '../state/store'
import { previewStore, runtime } from './harness'

const agents: readonly RuntimeInfo[] = Array.from({ length: 12 }, (_, index) => {
  const number = String(index + 1).padStart(2, '0')
  return runtime(`fixture-agent-${number}`, `Agent ${number}`)
})

const locations: Library['locations'] = agents.flatMap((agent) => [
  {
    runtime: agent.id,
    kind: 'skill' as const,
    path: `/home/u/.agents/${agent.id}/skills`,
    scope: 'user' as const,
    scanned: true,
    exists: true,
    readOnly: false,
  },
  {
    runtime: agent.id,
    kind: 'mcp' as const,
    path: `/home/u/.agents/${agent.id}/mcp.json`,
    scope: 'user' as const,
    scanned: true,
    exists: true,
    readOnly: false,
  },
])

const autopilot: LibraryEntry = {
  kind: 'skill',
  name: 'autopilot',
  title: null,
  description: 'A synthetic skill fixture with eleven copies outside the agents’ search paths.',
  catalogTokens: 88,
  copies: [{
    path: '/home/u/.agents/skills/autopilot',
    scope: 'user',
    readBy: [agents[11]!.id],
    hollow: false,
    digest: 'autopilot-fixture',
    readOnly: false,
  }],
  reach: agents.map((agent, index) => ({
    runtime: agent.id,
    state: index === 11 ? 'reaches' : 'unscanned',
    basis: 'scanned',
    ...(index < 3
      ? { note: 'On disk, but not in any directory this agent reads — it did not report it.' }
      : {}),
  })),
}

const libraryFor = (state: 'autopilot' | 'import'): Library => ({
  generatedAt: 1,
  home: '/home/u',
  runtimes: agents.map((agent) => agent.id),
  locations,
  entries: state === 'autopilot' ? [autopilot] : [],
  gaps: [],
})

/** Exact-length synthetic states for the Library owner checks. */
export const libraryAuditFixtureStore = (state: 'autopilot' | 'import'): AppStore => {
  const store = previewStore()
  Object.assign(store.getSnapshot(), { runtimes: agents })
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method, params) => {
    if (method === 'library/read') return libraryFor(state)
    if (method === 'library/definition' && state === 'autopilot') {
      return {
        name: 'autopilot',
        kind: 'skill',
        path: '/home/u/.agents/skills/autopilot',
        text: '---\nname: autopilot\ndescription: A synthetic skill used to check a multi-agent detail.\n---\n\nUse the installed definition as a preview fixture.\n',
        truncated: false,
        files: [{ path: 'SKILL.md', bytes: 132 }],
        moreFiles: 0,
      }
    }
    return request(method, params as never)
  }) as typeof store.transport.request
  return store
}
