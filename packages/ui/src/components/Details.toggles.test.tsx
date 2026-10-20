import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { itemId, turnId } from '@harnessdesk/protocol'
import { PREVIEW_SESSION_KEY, previewStore } from '../preview/harness'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { AgentsView, ChangesView, TrajectoryView } from './Details'

/**
 * Staged preserves its boolean filter; Timed preserves its All/Timed choice.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const snapshot = emptySnapshot()
const store = {
  subscribe: () => () => {},
  getSnapshot: () => snapshot,
  transport: { request: async () => null },
  notice: () => {},
} as unknown as AppStore

const toggle = (title: string): HTMLButtonElement => {
  const button = container.querySelector<HTMLButtonElement>(`button[title^="${title}"]`)
  if (!button) throw new Error(`no toggle titled ${title}`)
  return button
}

it('Staged is a switch that changes the same diff filter', () => {
  act(() => root.render(<StoreProvider store={store}><ChangesView /></StoreProvider>))
  const switchOf = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(switchOf().getAttribute('aria-checked')).toBe('false')
  act(() => switchOf().click())
  expect(switchOf().getAttribute('aria-checked')).toBe('true')
  act(() => switchOf().click())
  expect(switchOf().getAttribute('aria-checked')).toBe('false')
})
it('replaces Changes controls with one empty state for a clean working tree', async () => {
  const cleanSnapshot = { ...snapshot, workspace: { path: '/work/storefront', name: 'storefront' } }
  const cleanStore = {
    ...store,
    getSnapshot: () => cleanSnapshot,
    transport: { request: async (method: string) => method === 'git/status'
      ? { root: '/work/storefront', branch: 'main', ahead: 0, behind: 0, files: [] }
      : { diff: '' } },
  } as unknown as AppStore
  act(() => root.render(<StoreProvider store={cleanStore}><ChangesView /></StoreProvider>))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })

  expect(container.textContent).toContain('No changes yet')
  expect(container.querySelector('[aria-label="Filter files"]')).toBeNull()
  expect(container.querySelector('[role="switch"]')).toBeNull()
  expect(container.querySelector('[aria-label="Open review"]')).toBeNull()
  expect(container.querySelector('[aria-label="Export this session as Markdown"]')).toBeNull()
})
it('Timed is a mutually exclusive All/Timed choice preserving the filter', () => {
  act(() => root.render(<StoreProvider store={store}><TrajectoryView /></StoreProvider>))
  const choice = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(one => one.textContent === label)!
  expect(choice('All').getAttribute('aria-selected')).toBe('true')
  act(() => choice('Timed').click())
  expect(choice('Timed').getAttribute('aria-selected')).toBe('true')
  act(() => choice('All').click())
  expect(choice('All').getAttribute('aria-selected')).toBe('true')
})

it('puts the export glyph on the Details toolbar edge', () => {
  act(() => root.render(<StoreProvider store={store}><ChangesView /></StoreProvider>))
  const exportButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Export this session as Markdown"]',
  )
  expect(exportButton).not.toBeNull()
  expect(exportButton?.className).toContain('me-(--edge-pull)')
})

it('keeps sub-agent filters absent until there are actual delegated members', () => {
  act(() => root.render(<StoreProvider store={store}><AgentsView /></StoreProvider>))
  expect(container.querySelector('[aria-label="Filter sub-agents"]')).toBeNull()
  expect(container.querySelector('[aria-label="Export this session as Markdown"]')).toBeNull()
})

it('retains sub-agent filtering when a delegation has real members', async () => {
  const seed = previewStore().getSnapshot()
  const session = { ...seed.sessions.get(PREVIEW_SESSION_KEY)!, turns: [{
    id: turnId('delegated'), status: 'completed' as const, items: [{
      id: itemId('delegation'), type: 'subagent' as const, action: 'spawn' as const, status: 'completed' as const, prompt: null,
      members: [{ sessionId: 'child', nickname: 'Reviewer', state: 'completed', openable: false }],
    }],
  }] }
  const populated = previewStore({ ...seed, sessions: new Map([[PREVIEW_SESSION_KEY, session]]) })
  populated.seatRecord = async () => null
  await act(async () => root.render(<StoreProvider store={populated}><AgentsView /></StoreProvider>))
  expect(container.querySelector('[aria-label="Filter sub-agents"]')).not.toBeNull()
  expect(container.textContent).toContain('Reviewer')
})
