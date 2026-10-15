import { contributionId, NO_PERMISSIONS, pluginInstanceId, type Library, type PluginInstance } from '@harnessdesk/protocol'
import { LIBRARY, runtime } from './harness'

/** A small, healthy inventory made for the camera, with no machine home. */
export const STILL_LIBRARY: Library = {
  generatedAt: LIBRARY.generatedAt,
  runtimes: LIBRARY.runtimes,
  home: '/work/demo',
  locations: [],
  gaps: [],
  entries: LIBRARY.entries.filter(entry => ['code-review', 'brainstorming', 'design-review'].includes(entry.name)).map(entry => ({
    ...entry,
    kind: 'skill',
    description: { 'code-review': 'Review the current diff.', brainstorming: 'Explore the design before building.', 'design-review': 'Check the visual hierarchy.' }[entry.name] ?? '',
    copies: [{ path: entry.name, scope: 'user', digest: entry.copies[0]!.digest, hollow: false, readOnly: false, readBy: LIBRARY.runtimes }],
    reach: LIBRARY.runtimes.map(runtime => ({ runtime, state: 'reaches', basis: 'reported' })),
  })),
}

/** Fictional installed plugins; the detail page renders these grants itself. */
export const STILL_PLUGINS: PluginInstance[] = [
  { id: 'project-docs', name: 'Project docs', description: 'Find reference material for the open project.',
    permissions: { ...NO_PERMISSIONS, workspace: { read: true, write: false }, network: { hosts: ['docs.acme.dev'] } },
    tools: ['Read project reference files.', 'Find documentation on docs.acme.dev.'] },
  { id: 'project-checks', name: 'Project checks', description: 'Run the project’s checks and report their results.',
    permissions: { ...NO_PERMISSIONS, workspace: { read: true, write: false }, shell: true }, tools: ['Run the project checks.'] },
  { id: 'release-notes', name: 'Release notes', description: 'Gather changes for the next release.',
    permissions: { ...NO_PERMISSIONS, workspace: { read: true, write: false } }, tools: ['Read the release summary.'] },
].map(({ id, name, description, permissions, tools }) => ({
  instanceId: pluginInstanceId(id), identity: { id, name, description, version: '1.0.0', source: { kind: 'npm', specifier: `@acme/${id}` } },
  state: { type: 'active' }, revision: 1, permissions, injects: [], provides: [], enabled: true,
  contributions: tools.map((description, index) => ({ id: contributionId(`${id}/${index}`), owner: pluginInstanceId(id), revision: 1,
    scope: { kind: 'global' }, kind: 'tool', namespace: id, name: `read_${index}`, description, inputSchema: {} })),
}))

/** Runtime-authored presentation stand-ins for the public race's two providers. */
export const STILL_RUNTIMES = [runtime('codex', 'Codex'), runtime('claude', 'Claude Code')]

/** Fictional local-hour readings for two providers; the third remains unknown. */
export const STILL_HOURS = STILL_RUNTIMES.flatMap(runtime => Array.from({ length: 168 }, (_, index) => {
  const weekday = Math.floor(index / 24)
  const hour = index % 24
  const requests = weekday > 0 && weekday < 6 && hour >= 9 && hour <= 18 ? (hour - 8) * (weekday + 2) : 0
  return { runtime: runtime.id, weekday, hour, requests, tokens: requests * 2400 }
}))
