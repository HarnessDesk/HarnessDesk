import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, sessionId, type HistoryImportState, type HistorySummary, type RuntimeInfo } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { AppStore, emptySnapshot } from '../state/store'
import { AgentHistory, HistorySection } from './History'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const info: RuntimeInfo = { id: runtimeId('alpha'), name: 'Alpha', presentation: { name: 'Alpha' }, capabilities: { ...NO_CAPABILITIES, listHistory: true } }
const row = (id: string, patch: Partial<HistorySummary> = {}): HistorySummary => ({ runtime: info.id, id: sessionId(id), title: id, cwd: '/preview/project', repo: { root: '/preview/project', worktree: false }, preview: null, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2, hidden: false, ...patch })
const done: HistoryImportState = { state: 'done', count: 2000, importedAt: 1, lastScanAt: 2 }
let root: Root
let box: HTMLDivElement
let request: ReturnType<typeof vi.fn>
let own: AppStore
let onBrowse: ReturnType<typeof vi.fn<(id: string) => void>>
let onOpen: ReturnType<typeof vi.fn<() => void>>
let onOpenAgent: ReturnType<typeof vi.fn<(id: string) => void>>
const button = (name: string) => [...box.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent?.trim() === name)!
const input = (label: string, value: string) => act(() => {
  const field = box.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
})
const mount = async (state: HistoryImportState | null = done, agent = false, rows = [row('Imported')]) => {
  const snapshot = { ...emptySnapshot(), runtimes: [info], historyImports: { [info.id]: state } }
  request = vi.fn(async (method: string) => method === 'history/list' ? { data: rows, nextCursor: null } : null)
  own = { getSnapshot: () => snapshot, subscribe: () => () => {}, loadHistoryImport: vi.fn(async () => {}), transport: { request }, openSession: vi.fn(async () => {}) } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={own}>{agent ? <AgentHistory info={info} onBrowse={onBrowse} /> : <HistorySection onOpen={onOpen} onOpenAgent={onOpenAgent} />}</StoreProvider>))
}
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box); onBrowse = vi.fn(); onOpen = vi.fn(); onOpenAgent = vi.fn() })
afterEach(() => { act(() => root.unmount()); box.remove() })

it('queries titles and hidden rows on the host and opens a preview', async () => {
  await mount()
  expect(request).toHaveBeenCalledWith('history/list', { pageSize: 100, includeHidden: false })
  input('Search history titles', '100%_')
  await act(async () => {})
  expect(request).toHaveBeenLastCalledWith('history/list', { pageSize: 100, includeHidden: false, query: '100%_' })
  await act(async () => box.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
  expect(request).toHaveBeenLastCalledWith('history/list', { pageSize: 100, includeHidden: true, query: '100%_' })
  await act(async () => button('Imported').click())
  expect(own.openSession).toHaveBeenCalledWith(sessionId('Imported'), { runtime: info.id, preview: true })
  expect(onOpen).toHaveBeenCalled()
})

it('sends agent and project filters, then pages when scrolled near the end', async () => {
  await mount()
  const choose = async (label: string, value: string) => act(async () => {
    const select = box.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
    select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await choose('History agent', info.id)
  expect(request).toHaveBeenLastCalledWith('history/list', { pageSize: 100, includeHidden: false, runtimes: [info.id] })
  await choose('History project', '/preview/project')
  expect(request).toHaveBeenLastCalledWith('history/list', { pageSize: 100, includeHidden: false, runtimes: [info.id], repoRoot: '/preview/project' })
  request.mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => row(`Row ${i}`)), nextCursor: 'next' })
  input('Search history titles', 'Row')
  await act(async () => {})
  expect(box.querySelectorAll('[data-slot="table-row"]')).toHaveLength(16)
  const scroll = box.querySelector<HTMLElement>('[data-history-scroll]')!
  Object.defineProperty(scroll, 'scrollTop', { configurable: true, value: 4000 })
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 440 })
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 4450 })
  request.mockResolvedValueOnce({ data: [row('Next page')], nextCursor: null })
  await act(async () => scroll.dispatchEvent(new Event('scroll', { bubbles: true })))
  expect(request).toHaveBeenLastCalledWith('history/list', { pageSize: 100, includeHidden: false, runtimes: [info.id], repoRoot: '/preview/project', query: 'Row', cursor: 'next' })
})

it('points an empty import to its agent page and shows Archived on one line', async () => {
  await mount(null, false, [])
  expect(box.textContent).toContain('Import history from an agent’s settings page.')
  act(() => button('Alpha').click())
  expect(onOpenAgent).toHaveBeenCalledWith(info.id)
  await mount(done, false, [row('Filed', { archived: true })])
  expect(box.textContent).toContain('Archived')
  expect(box.querySelector('[data-slot="row-desc"]')).toBeNull()
})

it.each([
  [null, 'Import history', 'history/import'],
  [{ ...done, state: 'running' }, 'Cancel', 'history/cancel'],
  [done, 'Rescan', 'history/import'],
  [{ ...done, state: 'failed', error: 'Listing refused' }, 'Retry', 'history/import'],
] as const)('draws the import state and its action: %s', async (state, label, method) => {
  await mount(state as HistoryImportState | null, true)
  expect(button(label)).toBeTruthy()
  await act(async () => button(label).click())
  expect(request).toHaveBeenCalledWith(method, { runtime: info.id })
  if (state?.state === 'failed') expect(box.querySelector('[title="Listing refused"]')).not.toBeNull()
})

it('browses the agent filter and confirms removing only the imported records', async () => {
  await mount(done, true)
  act(() => button('Browse').click())
  expect(onBrowse).toHaveBeenCalledWith(info.id)
  act(() => button('Remove imported').click())
  expect(document.body.textContent).toContain('Alpha’s own files stay as they are.')
  await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(el => el.textContent === 'Remove imported')!.click())
  expect(request).toHaveBeenCalledWith('history/removeImported', { runtime: info.id })
})

it('discards a stale page after a new title query', async () => {
  await mount()
  let resolve!: (page: unknown) => void
  request.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
  input('Search history titles', 'old')
  await act(async () => {})
  request.mockResolvedValueOnce({ data: [row('Current')], nextCursor: null })
  input('Search history titles', 'new')
  await act(async () => {})
  await act(async () => resolve({ data: [row('Stale')], nextCursor: 'wrong' }))
  expect(box.textContent).toContain('Current')
  expect(box.textContent).not.toContain('Stale')
})

it('rescans imported agents at open and focus but never starts a first import', async () => {
  await mount()
  expect(request).toHaveBeenCalledWith('history/import', { runtime: info.id })
  request.mockClear()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(request).toHaveBeenCalledWith('history/import', { runtime: info.id })
  expect(request).toHaveBeenCalledWith('history/list', { pageSize: 100, includeHidden: false })
  await act(async () => root.unmount())
  root = createRoot(box)
  await mount(null)
  expect(request).not.toHaveBeenCalledWith('history/import', { runtime: info.id })
})

it('does not draw history on a runtime sharing another account’s store', async () => {
  await mount(null, true)
  await act(async () => root.render(<StoreProvider store={own}><AgentHistory info={{ ...info, capabilities: { ...info.capabilities, listHistory: false } }} onBrowse={onBrowse} /></StoreProvider>))
  expect(box.textContent).toBe('')
})


it.each(['index', 'focus'] as const)('keeps loaded pages and scroll while refreshing after %s', async (trigger) => {
  const store = new AppStore('ws://localhost:0/')
  const first = Array.from({ length: 100 }, (_, i) => row(`First ${i}`))
  const second = Array.from({ length: 100 }, (_, i) => row(`Second ${i}`))
  const listing = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { cursor?: string; pageSize?: number }) => {
    if (method !== 'history/list') return null
    if (params.cursor === 'second') return { data: second, nextCursor: 'third' }
    return { data: first, nextCursor: 'second' }
  }) as never)
  await act(async () => root.render(<StoreProvider store={store}><HistorySection onOpen={onOpen} onOpenAgent={onOpenAgent} /></StoreProvider>))
  const scroll = box.querySelector<HTMLDivElement>('[data-history-scroll]')!
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 440 })
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 4400 })
  scroll.scrollTop = 4000
  await act(async () => scroll.dispatchEvent(new Event('scroll', { bubbles: true })))
  expect(box.querySelector('table')?.getAttribute('aria-rowcount')).toBe('201')
  scroll.scrollTop = 4800
  // Defer refresh so the previous pages must stay mounted while reading.
  let resolve!: (page: { data: HistorySummary[]; nextCursor: string | null }) => void
  listing.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
  await act(async () => {
    if (trigger === 'focus') window.dispatchEvent(new Event('focus'))
    else (store.transport as unknown as { handlers: { onNotification(value: unknown): void } }).handlers.onNotification({ method: 'session/indexChanged', params: { upserted: [], removed: [] } })
  })
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  expect(box.querySelector('[data-history-scroll]')).toBe(scroll)
  expect(scroll.scrollTop).toBe(4800)
  expect(box.querySelector('table')?.getAttribute('aria-rowcount')).toBe('201')
  await act(async () => resolve({ data: first, nextCursor: 'second' }))
  expect(box.querySelector('table')?.getAttribute('aria-rowcount')).toBe('201')
  expect(scroll.scrollTop).toBe(4800)
  listing.mockResolvedValueOnce({ data: [row('Third page')], nextCursor: null })
  await act(async () => scroll.dispatchEvent(new Event('scroll', { bubbles: true })))
  expect(listing).toHaveBeenLastCalledWith('history/list', { pageSize: 100, includeHidden: false, cursor: 'third' })
  input('Search history titles', 'new filter')
  await act(async () => {})
  expect(box.querySelector<HTMLDivElement>('[data-history-scroll]')?.scrollTop).toBe(0)
})
