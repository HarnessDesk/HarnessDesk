import { splitSessionKey } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider, PaneProvider } from '../state/context'
import { previewStore, PREVIEW_SESSION_KEY } from '../preview/harness'
import { overviewTeamStore, overviewRun } from '../preview/team-overview-fixture'
import { views } from '../panels/views'
import '../panels/builtins'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); document.body.replaceChildren() })
it('reads the actual Team range and hides a delayed previous range after the target changes', async () => {
  const seed = overviewTeamStore('running').getSnapshot()
  const run = { ...overviewRun(), target: { kind: 'branch' as const, pr: null, label: 'Checkout', base: 'before-one', head: 'after-one', dirty: false, independence: 'unknown' as const } }
  const store = previewStore({ ...seed, workspace: { ...seed.workspace!, git: { branch: 'checkout' } as NonNullable<typeof seed.workspace>['git'] }, flowExecutions: new Map([[run.id, run]]) })
  const pending: ((value: { diff: string }) => void)[] = []
  const read = vi.fn(() => new Promise<{ diff: string }>(resolve => pending.push(resolve)))
  Object.assign(store, { readWorkDiff: read })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  const Changes = views.get('changes')!.component
  await act(async () => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'team', view: { kind: 'room', room: 'overview-team' }, sessionKey: null }}><Changes /></PaneProvider></StoreProvider>))
  expect(read).toHaveBeenCalledWith('/work/storefront', 'before-one', 'after-one')
  await act(async () => store.patch({ flowExecutions: new Map([[run.id, { ...run, target: { ...run.target, base: 'before-two', head: 'after-two' } }]]) }))
  expect(read).toHaveBeenCalledWith('/work/storefront', 'before-two', 'after-two')
  await act(async () => pending[0]!({ diff: 'diff --git a/old.txt b/old.txt\n--- a/old.txt\n+++ b/old.txt\n@@ -1 +1 @@\n-old\n+STALE RESPONSE' }))
  expect(container.textContent).not.toContain('STALE RESPONSE')
  expect(container.textContent).toContain('Reading the branch diff')
  await act(async () => pending[1]!({ diff: 'diff --git a/new.txt b/new.txt\n--- a/new.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-old\n+CURRENT RESPONSE' }))
  expect(container.textContent).toContain('CURRENT RESPONSE')
  expect(container.textContent).toContain('after-two')
})


it('the AppStore range source preserves the exact recorded host arguments', async () => {
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockResolvedValue({ diff: 'Recorded diff' })
  await expect(store.readWorkDiff('/work/storefront', 'base-recorded', 'head-recorded')).resolves.toEqual({ diff: 'Recorded diff' })
  expect(request).toHaveBeenCalledWith('git/diffRange', { root: '/work/storefront', from: 'base-recorded', to: 'head-recorded' })
})
it.each(['conversation', 'room'] as const)('default Activity reads only the mounted %s subject sessions', async kind => {
  const seed = overviewTeamStore('running').getSnapshot()
  const keys = kind === 'room' ? [...seed.sessions.keys()] : [PREVIEW_SESSION_KEY]
  const store = previewStore(kind === 'room' ? seed : {})
  Object.assign(store, { loadAudit: async () => [...keys.map((key, index) => ({ runtime: splitSessionKey(key).runtime, sessionId: splitSessionKey(key).id, at: 1000 + index, kind: 'library/write', op: 'skill/update', name: `Subject event ${index}` })),
    { runtime: 'fixture-agent', sessionId: 'foreign', at: 3000, kind: 'library/write', op: 'skill/update', name: 'Foreign event' }] })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  const Activity = views.get('activity')!.component
  await act(async () => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'owner', view: kind === 'room' ? { kind: 'room', room: 'overview-team' } : { kind: 'conversation', session: PREVIEW_SESSION_KEY }, sessionKey: kind === 'room' ? null : PREVIEW_SESSION_KEY }}><Activity /></PaneProvider></StoreProvider>))
  const events = container.querySelector('[data-slot="tool-section"][aria-label="Events"]')!
  for (const index of keys.keys()) expect(events.textContent).toContain(`Subject event ${index}`)
  expect(events.textContent).not.toContain('Foreign event')
  expect(container.querySelector('[data-slot="content-footer"]')).toBeNull()
  expect(container.querySelectorAll('[data-slot="tool-body"]')).toHaveLength(1)
  expect(container.querySelectorAll('[data-slot="tool-scroll"]')).toHaveLength(1)
})
