import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, sessionId, sessionKey, type StorageUsage, type StorageCleanupPreview, type RuntimeInfo } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore, type AppSnapshot } from '../state/store'
import { StorageSection } from './Storage'
import { resolveSection } from './Settings'
import type { PaneView } from '../state/layout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const info: RuntimeInfo = { id: runtimeId('alpha'), name: 'internal-name', presentation: { name: 'Alpha' }, capabilities: NO_CAPABILITIES }
const usage: StorageUsage = { database: { bytes: 2048, computing: false }, snapshots: { count: 3, bytes: 4096, computing: false }, cachedPreviews: { count: 5, bytes: 1024 }, worktrees: { count: 8, bytes: 8192, kept: 2, computing: false } }
const changes = { modified: 0, untracked: 0, files: [], ignored: [], ignoredCount: 0, unpushedCommits: 0 }
const preview: StorageCleanupPreview = { inventoryToken: 'confirmed', cleanBytes: 2048, candidates: [
  { runtime: info.id, sessionId: sessionId('clean'), title: 'Clean task', path: '/preview/worktrees/clean', bytes: 2048, changes, clean: true },
  { runtime: info.id, sessionId: sessionId('dirty'), title: 'Kept task', path: '/preview/worktrees/dirty', bytes: 1024, changes: { ...changes, ignoredCount: 1, ignored: ['.env'] }, clean: false },
] }
let root: Root, box: HTMLDivElement, request: ReturnType<typeof vi.fn>, notice: ReturnType<typeof vi.fn>
let snapshot: AppSnapshot
let listener: (usage: StorageUsage) => void
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent?.trim() === name)!
const mount = async (reading = usage) => {
  request = vi.fn(async (method: string) => {
    if (method === 'storage/usage') return reading
    if (method === 'storage/cleanupPreview') return preview
    if (method === 'storage/kept') return [{ runtime: info.id, sessionId: sessionId('gone'), title: 'Deleted task', path: '/preview/worktrees/kept', changes: { ...changes, ignoredCount: 1 } }]
    if (method === 'storage/cleanup') return { removed: 1, kept: 1, freedBytes: 2048, refused: [{ path: '/preview/worktrees/dirty', reason: 'changed since you looked' }] }
    if (method === 'history/clearCached') return { count: 5, bytes: 1024 }
    return null
  })
  notice = vi.fn()
  snapshot = { ...emptySnapshot(), runtimes: [info] }
  const own = { getSnapshot: () => snapshot, subscribe: () => () => {},
    subscribeStorageUsage: (fn: typeof listener) => { listener = fn; return () => {} }, notice, transport: { request } } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={own}><StorageSection /></StoreProvider>))
}
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box) })
afterEach(() => { act(() => root.unmount()); box.remove() })
it('shows four usage rows, counts, sizes and kept worktrees without second lines', async () => {
  await mount()
  for (const text of ['Conversation database', 'Snapshots', 'Cached previews', 'Worktrees', '2 KB', '3 · 4 KB', '5 · 1 KB', '8 · 8 KB', '2 kept', 'Deleted task']) expect(box.textContent).toContain(text)
  expect(box.querySelector('[data-slot="row-desc"]')).toBeNull()
  expect(box.querySelector('[title*="1 ignored"]')).not.toBeNull()
})
it('keeps Measuring… until the host event supplies the reading', async () => {
  await mount({ ...usage, worktrees: { ...usage.worktrees, computing: true } })
  expect(box.textContent).toContain('Measuring…')
  act(() => listener(usage))
  expect(box.textContent).not.toContain('Measuring…')
})
it('reviews two groups and exposes inventories only after the separate discard choice', async () => {
  await mount(); await act(async () => button('Review…').click())
  expect(document.body.textContent).toContain('Clean worktrees')
  expect(document.body.textContent).toContain('Worktrees with unsaved or ignored content')
  expect(document.body.textContent).not.toContain('.env')
  expect(button('Remove 1 worktree')).toBeTruthy()
  await act(async () => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
  expect(document.body.textContent).toContain('.env')
  expect(button('Remove 2 worktrees').getAttribute('data-variant')).toBe('danger')
  expect(button('Remove 2 worktrees').hasAttribute('data-filled')).toBe(true)
  await act(async () => button('Remove 2 worktrees').click())
  expect(request).toHaveBeenCalledWith('storage/cleanup', { olderThanDays: 30, exclude: [], includeDirty: true, inventoryToken: 'confirmed' })
  expect(notice).toHaveBeenCalledWith('info', 'Removed 1 worktree · freed 2 KB · 1 refused')
  expect(document.body.textContent).toContain('changed since you looked')
  expect(button('Review again').getAttribute('data-variant')).toBe('default')
  expect(document.querySelectorAll('[data-slot="dialog-footer"] [data-filled]')).toHaveLength(1)
})
it('requires confirmation before clearing cached previews', async () => {
  await mount(); await act(async () => button('Clear').click())
  expect(request).not.toHaveBeenCalledWith('history/clearCached', {})
  expect(document.body.textContent).toContain('read again from the agent')
  await act(async () => button('Clear cached previews').click())
  expect(request).toHaveBeenCalledWith('history/clearCached', {})
})

it('sends open and pinned conversations again at confirmation, including a pane opened during review', async () => {
  await mount()
  snapshot = { ...snapshot, listPrefs: { ...snapshot.listPrefs, pinnedSessions: [sessionKey(info.id, 'pinned')] } }
  await act(async () => button('Review…').click())
  expect(request).toHaveBeenCalledWith('storage/cleanupPreview', { olderThanDays: 30, exclude: [{ runtime: info.id, sessionId: 'pinned' }] })
  snapshot = { ...snapshot, layout: { ...snapshot.layout, root: { kind: 'pane', id: 'opened', view: { kind: 'conversation', session: sessionKey(info.id, 'opened') } } } }
  await act(async () => button('Remove 1 worktree').click())
  expect(request).toHaveBeenCalledWith('storage/cleanup', { olderThanDays: 30, exclude: [{ runtime: info.id, sessionId: 'opened' }, { runtime: info.id, sessionId: 'pinned' }], includeDirty: false, inventoryToken: 'confirmed' })
})

it('retains a completed measurement delivered while the post-cleanup kept list is loading', async () => {
  await mount(); await act(async () => button('Review…').click())
  let finish!: (value: unknown[]) => void
  const held = new Promise<unknown[]>(resolve => { finish = resolve })
  request.mockImplementation(async (method: string) => {
    if (method === 'storage/cleanup') return { removed: 1, kept: 0, freedBytes: 2048, refused: [] }
    if (method === 'storage/usage') return { ...usage, worktrees: { ...usage.worktrees, computing: true } }
    if (method === 'storage/kept') return held
    return null
  })
  await act(async () => button('Remove 1 worktree').click())
  act(() => listener(usage))
  await act(async () => finish([]))
  expect(box.textContent).not.toContain('Measuring…')
})

it.each(['pane', 'dock'] as const)('excludes settled room tiles, watching and tile pins from the %s at preview and confirmation', async place => {
  await mount()
  const shown = sessionKey(info.id, 'shown-seat'), legacy = sessionKey(info.id, 'legacy-seat'), pinned = sessionKey(info.id, 'tile-pin')
  const room = (tiles: readonly typeof shown[]): PaneView => ({ kind: 'room', room: 'synthetic-team', watching: [legacy, shown], sideBySide: { tiles, pinned: [pinned] } })
  const setRoom = (view: PaneView) => {
    snapshot = place === 'pane'
      ? { ...snapshot, layout: { ...snapshot.layout, root: { kind: 'pane', id: 'room-pane', view } } }
      : { ...snapshot, workbench: { ...snapshot.workbench, right: { ...snapshot.workbench.right, root: { kind: 'stack', id: 'room-stack', views: [{ id: 'room-dock', view }], active: 'room-dock' } } } }
  }
  // A settled transcript stays in the window after its host live handle is released.
  snapshot = { ...snapshot, sessions: new Map([[shown, { runtime: info.id, id: sessionId('shown-seat'), cwd: '/preview/worktrees/shown-seat', status: { type: 'idle' as const }, createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true }]]) }
  setRoom(room([shown]))
  await act(async () => button('Review…').click())
  const excluded = (method: string) => request.mock.calls.find(([name]) => name === method)![1].exclude.map((row: { sessionId: string }) => row.sessionId).sort()
  expect(excluded('storage/cleanupPreview')).toEqual(['legacy-seat', 'shown-seat', 'tile-pin'])
  setRoom(room([shown, sessionKey(info.id, 'new-seat')]))
  await act(async () => button('Remove 1 worktree').click())
  expect(excluded('storage/cleanup')).toEqual(['legacy-seat', 'new-seat', 'shown-seat', 'tile-pin'])
})

it('keeps a filled proceeding action while a preview is loading and after a refusal to read it', async () => {
  await mount()
  let refuse!: (error: Error) => void
  request.mockImplementation((method: string) => method === 'storage/cleanupPreview' ? new Promise((_resolve, reject) => { refuse = reject }) : Promise.resolve(null))
  await act(async () => button('Review…').click())
  expect(button('Review again').disabled).toBe(true)
  expect(button('Review again').getAttribute('data-variant')).toBe('default')
  expect(document.querySelectorAll('[data-slot="dialog-footer"] [data-filled]')).toHaveLength(1)
  await act(async () => refuse(new Error('Inventory unavailable')))
  expect(button('Review again').disabled).toBe(false)
  expect(button('Review again').getAttribute('data-variant')).toBe('default')
  expect(document.querySelectorAll('[data-slot="dialog-footer"] [data-filled]')).toHaveLength(1)
})

it('resolves the Storage route requested by the palette and restored navigation', () => {
  expect(resolveSection('storage')).toBe('storage')
})
