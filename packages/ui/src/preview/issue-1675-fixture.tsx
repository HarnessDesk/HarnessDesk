import { useMemo } from 'react'
import type { ConfigOption, Library, Session } from '@harnessdesk/protocol'
import { App } from '../app/App'
import { StoreProvider } from '../state/context'
import { frameDestinationStore } from './frame-destination-store'
import { LIBRARY, previewStore } from './harness'
import { teamStartStore } from './frames-team-start'
import { TEAM_START_POLICIES } from './team-start-fixture'
import { FrontDoor } from '../components/FrontDoor'
import { useTheme } from '../state/theme'

/** Placeholder-only scenes for the navigation and picker regression evidence. */
export const Issue1675Frames = () => {
  const scene = new URLSearchParams(location.search).get('issue-1675')
  const store = useMemo(() => {
    if (scene === 'team') {
      const team = teamStartStore()
      return new Proxy(team, { get(target, key, receiver) {
        if (key === 'flowSource') return async () => JSON.stringify(TEAM_START_POLICIES['fix-and-review'])
        const value = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
    const fixture = previewStore()
    fixture.patch({ theme: new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light' })
    const snapshot = fixture.getSnapshot()
    if (scene === 'model') {
      const sessions = new Map(snapshot.sessions)
      for (const [key, session] of sessions) sessions.set(key, { ...session, options: [
        { id: 'model', type: 'select', category: 'model', label: 'Model', currentValue: 'large', choices: [{ value: 'large', label: 'Opus 5.5' }] },
        { id: 'effort', type: 'select', category: 'thought_level', label: 'Effort', currentValue: 'xhigh', choices: [{ value: 'xhigh', label: 'Extra high' }] },
      ] as ConfigOption[] } as Session)
      fixture.patch({ sessions, draftOptions: [...sessions.values()][0]!.options })
    }
    const request = fixture.transport.request.bind(fixture.transport)
    fixture.transport.request = (async (method, params) => {
      if (method === 'library/definition') return { kind: 'skill', name: 'code-review', path: '/home/u/.agents/skills/code-review/SKILL.md',
        text: '---\nname: code-review\ndescription: Review `src/` before changing files.\n---\n\n# Code review\n\nRead the changed files and their callers before proposing a repair.',
        truncated: false, files: [{ path: 'SKILL.md', bytes: 160 }], moreFiles: 0 }
      if (method === 'library/read') {
        const healthy = LIBRARY.entries.find(entry => entry.kind === 'skill')!
        const broken = { ...healthy, name: '_hd', description: null,
          copies: healthy.copies.map(copy => ({ ...copy, path: '/home/u/.agents/skills/_hd', hollow: true, digest: null })),
          reach: healthy.reach.map(reach => ({ ...reach, state: 'hollow' as const })) }
        return { ...LIBRARY, home: '/home/u', entries: [broken, { ...healthy, description: 'Review `src/` before changing files.' }] } as unknown as Library
      }
      return request(method, params)
    }) as typeof fixture.transport.request
    const own = frameDestinationStore(fixture)
    if (scene?.startsWith('library')) own.openDestination({ kind: 'library', section: 'skill' })
    return own
  }, [scene])
  return <StoreProvider store={store}>{scene === 'team'
    ? <TeamScene />
    : <App />}</StoreProvider>
}

const TeamScene = () => {
  useTheme()
  return <FrontDoor context={{ kind: 'project', root: '/work/storefront' }} initial={{ id: 'fix-and-review', origin: 'builtin' }} onClose={() => {}} onStarted={() => {}} />
}
