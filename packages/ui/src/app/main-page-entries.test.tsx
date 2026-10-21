import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { MainPages } from './MainPages'

/**
 * Where **Back to Customize** lands from the Changes page.
 *
 * The page it is pressed on is reached from the Library's own menu, from the
 * toast that follows a write, and from anywhere a toast can appear. Back has
 * to return to the section the person left — MCP as readily as Skills — and
 * step through the store's one history rather than visiting a fixed section.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement, root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const settle = () => act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })

const libraryStore = (): AppStore => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { status: 'open', runtimes: [], agents: [] })
  store.transport.request = (async (method: string) => {
    if (method === 'library/read') return { generatedAt: 1, home: '/home/u', runtimes: [], locations: [], entries: [], gaps: [] }
    if (method === 'library/usage') return { generatedAt: 1, sessionsScanned: 0, skills: {} }
    if (method === 'agent/list' || method === 'agent/seat/dry') return []
    return {}
  }) as typeof store.transport.request
  store.loadAgents = vi.fn(async () => {})
  return store
}

const renderPages = async (store: AppStore) => act(async () => root.render(
  <StoreProvider store={store}><MainPages onSignIn={() => {}} onNewTeam={() => {}} libraryImportIntent={0} /></StoreProvider>,
))

it('Back to Customize from Changes returns to the section the person left', async () => {
  const store = libraryStore()
  store.openDestination({ kind: 'library', section: 'mcp' })
  store.openDestination({ kind: 'library', section: 'changes' })
  await renderPages(store)
  await settle()
  const back = [...container.querySelectorAll('button')].find(one => one.textContent === 'Back to Customize')
  expect(back, 'the Changes page should offer Back to Customize').toBeTruthy()
  await act(async () => back!.click())
  await settle()
  expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'library', section: 'mcp' })
  expect(container.querySelector('[data-page-destination="library"]')).not.toBeNull()
})

it('Back to Customize steps onto the skill detail it came from, not a fresh Skills visit', async () => {
  const store = libraryStore()
  store.openDestination({ kind: 'library', section: 'skill' })
  store.openDestination({ kind: 'library', section: 'skill', id: 'code-review' })
  store.openDestination({ kind: 'library', section: 'changes' })
  await renderPages(store)
  await settle()
  const before = store.getSnapshot().workbench.navigation.back.length
  const back = [...container.querySelectorAll('button')].find(one => one.textContent === 'Back to Customize')
  expect(back, 'the Changes page should offer Back to Customize').toBeTruthy()
  await act(async () => back!.click())
  await settle()
  // A visit to the section would have dropped the id and pushed, not stepped.
  expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'library', section: 'skill', id: 'code-review' })
  expect(store.getSnapshot().workbench.navigation.back.length).toBe(before - 1)
})


it('applies external runtime scope to a retained Customize page, including while already active', async () => {
  const store = libraryStore()
  const first = runtimeId('one'), second = runtimeId('two')
  Object.assign(store.getSnapshot(), { runtimes: [first, second].map((id, index) => ({ id, name: `Agent ${index + 1}`, capabilities: {}, presentation: { name: `Agent ${index + 1}` } })) })
  store.openDestination({ kind: 'library', section: 'skill' })
  await renderPages(store); await settle()
  const runtime = () => container.querySelector<HTMLButtonElement>('[title="Runtime"]')!
  expect(runtime().textContent).toContain('All runtimes')
  // Settings can address a runtime that has not been scanned into the library yet.
  act(() => store.setLibraryView('skill', { ...store.libraryView('skill'), runtime: second }))
  await settle()
  expect(runtime().textContent).toContain('Agent 2')
  act(() => store.returnToWork()); await settle()
  act(() => {
    store.setLibraryView('skill', { ...store.libraryView('skill'), runtime: first })
    store.openDestination({ kind: 'library', section: 'skill' })
  })
  await settle()
  expect(runtime().textContent).toContain('Agent 1')
  await act(async () => runtime().click())
  const all = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(one => one.textContent === 'All runtimes')!
  await act(async () => all.click()); await settle()
  expect(store.libraryView('skill').runtime).toBe('')
  expect(runtime().textContent).toContain('All runtimes')
})
