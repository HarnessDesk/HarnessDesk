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
    const summary = () => [...host.querySelectorAll('[data-slot="inspector-group"]')].find(el => el.textContent?.includes('This turn'))!
    expect(summary().textContent).toContain('1 outside')
    const filter = host.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!
    const setFilter = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, value); filter.dispatchEvent(new Event('input', { bubbles: true })) })
    await setFilter('a.ts')
    expect(summary().textContent).toContain('This turn · 1 file')
    expect(summary().textContent).not.toContain('outside')
    await setFilter('check.js')
    expect(host.textContent).toContain('This turn · 1 file')
    expect(host.textContent).toContain('Outside')
    expect(summary().textContent).toContain('1 outside')
    await setFilter('')
    expect(summary().textContent).toContain('This turn · 2 files')
    expect(summary().textContent).toContain('1 outside')
    await act(async () => { snapshot = { ...snapshot, workspaces: [{ path: '/tmp', name: 'tmp', lastOpenedAt: 1 }] }; listeners.forEach(fn => fn()) })
    expect(host.textContent).not.toContain('Outside')
    expect(summary().textContent).not.toContain('outside')
    const other = sessionKey('fixture', 'two')
    await act(async () => { snapshot = { ...snapshot, workspaces: [], sessions: new Map([[key, session], [other, { ...session, cwd: '/tmp' }]]) }; listeners.forEach(fn => fn()) })
    expect(host.textContent).not.toContain('Outside')
    expect(summary().textContent).not.toContain('outside')
    await act(async () => { snapshot = { ...snapshot, sessions: new Map([[key, session]]) }; listeners.forEach(fn => fn()) })
    expect(host.textContent).toContain('Outside')
    expect(summary().textContent).toContain('1 outside')
    await act(async () => { snapshot = { ...snapshot, sessions: new Map([[key, { ...session, cwd: '', turns: [{ ...session.turns[0]!, diff: '@@ -1 +1 @@\n-a\n+b' }] }]]) }; listeners.forEach(fn => fn()) })
    expect(host.textContent).toContain('Location unknown')
    expect(summary().textContent).not.toContain('outside')
    await act(async () => { snapshot = { ...snapshot, sessions: new Map([[key, { ...session, cwd: '', turns: [{ ...session.turns[0]!, diff: 'diff --git a/relative.ts b/relative.ts\n@@ -1 +1 @@\n-a\n+b' }] }]]) }; listeners.forEach(fn => fn()) })
    expect(host.textContent).toContain('Location unknown')
  } finally { await act(async () => root.unmount()); host.remove() }
})

it('classifies both reported rename endpoints in the turn diff without changing Git counts', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const key = sessionKey('fixture', 'rename')
  const changes = [
    { path: '/work/app/src/a.ts', kind: { type: 'update', movePath: '/tmp/a.ts' }, diff: '@@ -1 +1 @@\n-a\n+b' },
    { path: '/tmp/b.ts', kind: { type: 'update', movePath: '/work/app/src/b.ts' }, diff: '@@ -1 +1 @@\n-a\n+b' },
  ]
  const diff = ['diff --git a/src/a.ts b//tmp/a.ts', '@@ -1 +1 @@', '-a', '+b', 'diff --git a//tmp/b.ts b/src/b.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n')
  const session = { cwd: '/work/app', status: { type: 'idle' }, turns: [{ id: turnId('one'), status: 'completed', items: [{ type: 'fileChange', changes }], diff }] } as unknown as Session
  const snapshot = { ...emptySnapshot(), activeSessionKey: key, sessions: new Map([[key, session]]), workspace: { path: '/work/app', name: 'app', lastOpenedAt: 1 } } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, notice: vi.fn(), transport: { request: vi.fn(async (method: string) => method === 'git/status' ? { root: '/work/app', branch: 'main', ahead: 0, behind: 0, files: [{ path: 'other.ts', status: 'modified', staged: false }] } : { diff: '' }) } } as unknown as AppStore
  try {
    await act(async () => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'owner', view: { kind: 'conversation', session: key }, sessionKey: key }}><ChangesView /></PaneProvider></StoreProvider>))
    const summary = [...host.querySelectorAll('[data-slot="inspector-group"]')].find(el => el.textContent?.includes('This turn'))!
    expect(summary.textContent).toContain('This turn · 2 files')
    expect(summary.textContent).toContain('2 outside')
    expect(host.textContent).toContain('Working tree · 1')
    // Each file is labelled in the navigation and beside its diff.
    expect([...host.querySelectorAll('[data-slot="chip"]')].filter(el => el.textContent === 'Outside')).toHaveLength(4)
  } finally { await act(async () => root.unmount()); host.remove() }
})

it.each([
  { name: 'Windows outside to inside', cwd: 'C:/Repo', source: 'C:/Elsewhere/a.ts', destination: 'c:/repo/src/a.ts', diffPath: 'src/A.ts', location: 'outside' },
  { name: 'Windows inside to outside', cwd: 'C:/Repo', source: 'C:/Repo/src/b.ts', destination: 'c:/elsewhere/b.ts', diffPath: 'C:/Elsewhere/B.ts', location: 'outside' },
  { name: 'POSIX names remain case sensitive', cwd: '/work/app', source: '/tmp/c.ts', destination: '/work/app/src/c.ts', diffPath: 'src/C.ts', location: 'inside' },
  { name: 'a descendant is not the same path', cwd: 'C:/Repo', source: 'C:/Elsewhere/d.ts', destination: 'C:/Repo/src/dir', diffPath: 'src/dir/file.ts', location: 'inside' },
  { name: 'unlocatable diff paths remain unknown', cwd: 'C:/Repo', source: 'C:/Elsewhere/e.ts', destination: 'C:relative.ts', diffPath: 'C:relative.ts', location: 'unknown' },
])('matches rename paths with the existing path rules: $name', async ({ cwd, source, destination, diffPath, location }) => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const key = sessionKey('fixture', 'case-rename')
  const changes = [{ path: source, kind: { type: 'update', movePath: destination }, diff: '@@ -1 +1 @@\n-a\n+b' }]
  const diff = `diff --git a/${diffPath} b/${diffPath}\n@@ -1 +1 @@\n-a\n+b`
  const session = { cwd, status: { type: 'idle' }, turns: [{ id: turnId('one'), status: 'completed', items: [{ type: 'fileChange', changes }], diff }] } as unknown as Session
  const snapshot = { ...emptySnapshot(), activeSessionKey: key, sessions: new Map([[key, session]]), workspace: { path: cwd, name: 'repo', lastOpenedAt: 1 } } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, notice: vi.fn(), transport: { request: vi.fn(async (method: string) => method === 'git/status' ? { root: cwd, branch: 'main', ahead: 0, behind: 0, files: [{ path: 'other.ts', status: 'modified', staged: false }] } : { diff: '' }) } } as unknown as AppStore
  try {
    await act(async () => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'owner', view: { kind: 'conversation', session: key }, sessionKey: key }}><ChangesView /></PaneProvider></StoreProvider>))
    const summary = [...host.querySelectorAll('[data-slot="inspector-group"]')].find(el => el.textContent?.includes('This turn'))!
    expect(summary.textContent).toContain('This turn · 1 file')
    expect(host.textContent).toContain('Working tree · 1')
    expect(summary.textContent?.includes('1 outside')).toBe(location === 'outside')
    const chips = [...host.querySelectorAll('[data-slot="chip"]')].map(el => el.textContent)
    expect(chips.includes('Outside')).toBe(location === 'outside')
    expect(chips.includes('Location unknown')).toBe(location === 'unknown')
  } finally { await act(async () => root.unmount()); host.remove() }
})
