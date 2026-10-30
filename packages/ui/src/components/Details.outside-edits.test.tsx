import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { sessionKey, turnId, type Session } from '@harnessdesk/protocol'
import { StoreProvider, PaneProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ChangesView } from './Details'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('classifies turn diff against the conversation, independently of Git and updates roots', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const key = sessionKey('fixture', 'one')
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '@@ -1 +1 @@', '-a', '+b', 'diff --git a//tmp/check.js b//tmp/check.js', '@@ -1 +1 @@', '-a', '+b'].join('\n')
  const session = { cwd: '/work/app', status: { type: 'idle' }, turns: [{ id: turnId('one'), status: 'completed', items: [], diff }] } as unknown as Session
  let snapshot = { ...emptySnapshot(), activeSessionKey: key, sessions: new Map([[key, session]]), workspace: { path: '/work/app', name: 'app', lastOpenedAt: 1 } } as AppSnapshot
  const listeners = new Set<() => void>()
  const store = { subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => snapshot, notice: vi.fn(), transport: { request: vi.fn(async (method: string) => method === 'git/status' ? { root: '/work/app', branch: 'main', ahead: 0, behind: 0, files: [{ path: 'a.ts', status: 'modified', staged: false }] } : { diff: '' }) } } as unknown as AppStore
  try {
    await act(async () => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'owner', view: { kind: 'conversation', session: key }, sessionKey: key }}><ChangesView /></PaneProvider></StoreProvider>))
    expect(host.textContent).toContain('This turn · 2 files')
    expect(host.textContent).toContain('Working tree · 1')
    expect(host.textContent).toContain('Outside')
    const filter = host.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, 'check.js'); filter.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(host.textContent).toContain('This turn · 1 file')
    expect(host.textContent).toContain('Outside')
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, ''); filter.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { snapshot = { ...snapshot, workspaces: [{ path: '/tmp', name: 'tmp', lastOpenedAt: 1 }] }; listeners.forEach(fn => fn()) })
    expect(host.textContent).not.toContain('Outside')
    const other = sessionKey('fixture', 'two')
    await act(async () => { snapshot = { ...snapshot, workspaces: [], sessions: new Map([[key, session], [other, { ...session, cwd: '/tmp' }]]) }; listeners.forEach(fn => fn()) })
    expect(host.textContent).not.toContain('Outside')
    await act(async () => { snapshot = { ...snapshot, sessions: new Map([[key, session]]) }; listeners.forEach(fn => fn()) })
    expect(host.textContent).toContain('Outside')
    await act(async () => { snapshot = { ...snapshot, sessions: new Map([[key, { ...session, cwd: '', turns: [{ ...session.turns[0]!, diff: '@@ -1 +1 @@\n-a\n+b' }] }]]) }; listeners.forEach(fn => fn()) })
    expect(host.textContent).toContain('Location unknown')
    await act(async () => { snapshot = { ...snapshot, sessions: new Map([[key, { ...session, cwd: '', turns: [{ ...session.turns[0]!, diff: 'diff --git a/relative.ts b/relative.ts\n@@ -1 +1 @@\n-a\n+b' }] }]]) }; listeners.forEach(fn => fn()) })
    expect(host.textContent).toContain('Location unknown')
  } finally { await act(async () => root.unmount()); host.remove() }
})
