import { expect, it, vi } from 'vitest'
import { sessionBrowserProfile, runtimeId, sessionId, type Session } from '@harnessdesk/protocol'
import { browserPartition } from '../lib/desktop'
import { AppStore } from './store'
import { dockViews, readWorkbench } from './workbench'
import '../panels/builtins'

it('two conversations in one checkout retain separate browser tabs across switching and restoration', async () => {
  const store = new AppStore('ws://localhost:0/')
  const runtime = runtimeId('fixture')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { sessionId?: string }) => {
    if (method === 'runtime/sessionDefaults') return []
    if (method === 'session/read' || method === 'session/resume') return {
      runtime, id: sessionId(params.sessionId!), cwd: '/workspace/shared', status: { type: 'idle' },
      createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true,
    } satisfies Session
    return null
  }) as never)
  await store.openSession(sessionId('alpha'), { runtime })
  store.openBrowser('https://example.com/alpha')
  const first = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  await store.openSession(sessionId('beta'), { runtime })
  store.openBrowser('https://example.com/beta')
  const browsers = dockViews(store.getSnapshot().workbench.right).filter(one => one.view.kind === 'browser')
  expect(browsers).toHaveLength(2)
  expect(browsers[0]!.view).toEqual(first.view)
  const profiles = browsers.map(one => one.view.kind === 'browser' ? one.view.profile : undefined)
  expect(profiles).toEqual([sessionBrowserProfile(runtime, 'alpha'), sessionBrowserProfile(runtime, 'beta')])
  expect(new Set(profiles).size).toBe(2)
  expect(profiles.every(profile => profile?.startsWith('session-'))).toBe(true)
  const restored = readWorkbench(JSON.parse(JSON.stringify(store.getSnapshot().workbench)))!
  expect(dockViews(restored.right).filter(one => one.view.kind === 'browser')).toEqual(browsers)
  store.closeBrowser(profiles[1])
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === first.id)?.view).toEqual(first.view)
})

it('the real webview partition accepts session identities independently of the default persistence preference', () => {
  const profile = sessionBrowserProfile('fixture', 'alpha')
  expect(browserPartition(profile, true)).toBe(`persist:hd-${profile}`)
  expect(browserPartition(profile, false)).toBe(`persist:hd-${profile}`)
})

it('a first tool open for a background session belongs to that session without changing the foreground', async () => {
  const store = new AppStore('ws://localhost:0/')
  store.openDefaultView({ kind: 'conversation', session: 'fixture\u0000alpha' as never })
  const before = store.getSnapshot().workbench
  store.openBrowser('https://example.com/beta', { profile: sessionBrowserProfile('fixture', 'beta'), driven: true })
  const after = store.getSnapshot().workbench
  const browser = dockViews(after.right).find(one => one.view.kind === 'browser')!
  expect(after.toolOwners[browser.id]).toBe('session:fixture\u0000beta')
  expect(after.main).toEqual(before.main)
  expect(after.navigation).toEqual(before.navigation)
})
