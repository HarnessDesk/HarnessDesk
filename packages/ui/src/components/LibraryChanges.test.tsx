import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { LibraryChanges } from './LibraryChanges'
vi.mock('../panels/destination-page', () => ({ DestinationBar: () => null, useDestinationActive: () => true }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const now = new Date(2026, 9, 17, 12).getTime()
const day = 86400000
const entry = (name: string, at: number, extra = {}) => ({ kind: 'library/write', op: 'skill/update', name, at, path: `/home/jane/skills/${name}`, runtime: 'alpha', status: 'done', ...extra })
const rows = [entry('today', now, { backupPath: '/home/jane/backups/today' }), entry('yesterday', now - day, { op: 'skill/remove' }), entry('earlier', now - 5 * day, { op: 'skill/replace' }), entry('failed', now, { status: 'failed', detail: 'Permission denied', backupPath: '/home/jane/backups/failed' }), entry('installed', now, { op: 'skill/create' })]
const button = (text: string) => [...container.querySelectorAll('button')].find(el => el.textContent?.startsWith(text))!
const click = async (text: string) => { await act(async () => button(text).click()) }
const mount = async (entries = [...rows, { ...entry('other work', now), kind: 'turn' }], outcome: 'done' | 'failed' = 'done', workspace?: string, audit?: () => Promise<unknown>) => {
  const snapshot = { runtimes: [{ id: 'alpha', presentation: { name: 'Alpha' } }], ...(workspace ? { workspace: { path: workspace } } : {}) }
  let applied = false
  const request = vi.fn(async (method: string) => {
    if (method === 'audit/query' && audit) return audit()
    if (method === 'audit/query') return applied && outcome === 'failed' ? [...entries, entry('restore-attempt', now + 1000, { op: 'skill/replace', status: 'failed', detail: 'Permission denied' })] : entries
    if (method === 'library/read') return { generatedAt: 1, home: '/home/jane', runtimes: ['alpha'], locations: [], entries: [], gaps: [] }
    if (method === 'library/plan') return { plannedAt: 1, ops: [{ id: 'restore', kind: 'skill', name: 'today', action: 'replace', targetPath: '/home/jane/skills/today', guardDigest: null, backup: true }] }
    if (method === 'library/apply') { applied = true; return [{ id: 'restore', outcome, detail: 'Permission denied' }] }
    throw new Error(method)
  })
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, transport: { request }, openDestination: vi.fn() } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><LibraryChanges onBack={() => {}} now={now} /></StoreProvider>))
  return request
}
it('groups by local day with counts, operation marks, runtime names, tabular times and short paths', async () => {
  const request = await mount()
  expect(request).toHaveBeenCalledWith('audit/query', { sinceDays: 90 })
  expect([...container.querySelectorAll('h2')].map(el => el.textContent)).toEqual(['Today 3', 'Yesterday 1', 'Earlier 1'])
  expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(5)
  expect(container.querySelector('[data-slot="separator"]')).toBeNull()
  expect(container.textContent).toContain('Installed installed')
  expect(container.textContent).toContain('Removed a copy of yesterday')
  expect(container.textContent).toContain('Replaced a copy of earlier')
  expect(container.textContent).toContain('Failed to update failed — Permission denied')
  const desc = container.querySelector('[data-slot="row-desc"]')!
  expect(desc.textContent).toContain('Alpha')
  expect(desc.textContent).toContain('~/skills/today')
  expect(desc.textContent).toContain(new Date(now).toLocaleTimeString(undefined, { timeStyle: 'short' }))
  expect(desc.textContent).not.toContain('2026')
  expect(container.textContent).not.toContain('other work')
  expect(container.textContent).toContain(new Date(now - 5 * day).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
  expect(desc.querySelector('[title]')?.getAttribute('title')).toBe('/home/jane/skills/today')
  expect(button('Restore…').className).toContain('border-(--hd-btn-border)')
  expect(desc.querySelector('[data-role="meta"]')?.className).toContain('tabular-nums')
  expect(container.querySelectorAll('[data-slot="row-mark"] svg').length).toBeGreaterThan(0)
})
it('filters with counts, searches names and paths, clears no matches and excludes failed backups from Restore', async () => {
  await mount()
  expect(button('All').textContent).toBe('All5')
  expect(button('Can restore').textContent).toBe('Can restore1')
  expect(button('Failed').textContent).toBe('Failed1')
  expect([...container.querySelectorAll('button')].filter(el => el.textContent === 'Restore…')).toHaveLength(1)
  await click('Can restore'); expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(1)
  await click('Failed'); expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(1)
  expect(container.textContent).not.toContain('Restore…')
  await click('All')
  const search = container.querySelector('input')!
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { set.call(search, '/skills/earlier'); search.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(1)
  await act(async () => { set.call(search, 'not-found'); search.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(container.textContent).toContain('Nothing matches')
  await click('Clear'); expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(5)
})
it('opens the same restore plan and refetches audit after apply', async () => {
  const request = await mount()
  await click('Restore…')
  expect(request).toHaveBeenCalledWith('library/plan', { intents: [{ kind: 'restoreCopy', name: 'today', backupPath: '/home/jane/backups/today', targetPath: '/home/jane/skills/today' }] })
  await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === 'Apply 1 change')!.click())
  expect(request.mock.calls.filter(([method]) => method === 'audit/query')).toHaveLength(2)
})
it('shows one short empty state without an empty description', async () => {
  await mount([])
  expect(container.textContent).toContain('Nothing has been changed from here.')
  expect(container.querySelectorAll('[data-slot="empty-state"]')).toHaveLength(1)
  expect(container.textContent).not.toContain('Nothing matches')
})

it('keeps MCP failure wording on the changes page', async () => {
  await mount([entry('fetcher', now, { op: 'mcp/create', status: 'failed', detail: 'No write permission' })])
  expect(container.textContent).toContain('Failed to add fetcher — No write permission')
  expect([...container.querySelectorAll('button')].filter(el => el.textContent === 'Restore…')).toHaveLength(0)
})

it('refetches failed restore attempts so View changes includes the failure', async () => {
  const request = await mount(rows, 'failed')
  await click('Restore…')
  await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === 'Apply 1 change')!.click())
  expect(request.mock.calls.filter(([method]) => method === 'audit/query')).toHaveLength(2)
  expect(container.textContent).toContain('Failed to replace a copy of restore-attempt — Permission denied')
})

it('plans a restore in the open workspace, so a project copy can come back', async () => {
  const request = await mount(rows, 'done', '/home/jane/project')
  await click('Restore…')
  expect(request).toHaveBeenCalledWith('library/plan', { intents: [{ kind: 'restoreCopy', name: 'today', backupPath: '/home/jane/backups/today', targetPath: '/home/jane/skills/today' }], cwd: '/home/jane/project' })
})

it('says why the changes could not be read instead of showing none', async () => {
  await mount(rows, 'done', undefined, async () => { throw new Error('Audit log unreadable') })
  expect(container.textContent).toContain('Audit log unreadable')
  expect(container.textContent).not.toContain('Nothing has been changed from here.')
})

it('puts the newest change first within a day and leaves out a runtime it cannot name', async () => {
  await mount([entry('older', now - 60000), entry('newer', now), entry('gone', now - 120000, { runtime: 'host' })])
  expect([...container.querySelectorAll('[role="listitem"]')].map(el => el.textContent?.match(/Updated ([a-z]+)/)?.[1])).toEqual(['newer', 'older', 'gone'])
  expect(container.textContent).not.toContain('Unavailable runtime')
})
