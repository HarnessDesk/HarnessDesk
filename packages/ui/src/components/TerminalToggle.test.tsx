import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId } from '@harnessdesk/protocol'

import { Menu } from '../design'

import { StoreProvider } from '../state/context'
import type { TerminalView } from '../state/layout'
import { dock, dockViews } from '../state/workbench'
import { AppStore, emptySnapshot, type AppSnapshot } from '../state/store'
import { TerminalToggle, TerminalMenuItem, toggleTerminal } from './TerminalToggle'

/**
 * The terminal button at the app foot is an on/off switch.
 *
 * The press that matters is the second one: whether it lands after the bottom
 * panel has a shell or while the first is still opening, it has to close it —
 * never ask the runtime for a shell nobody wanted. That is what a double
 * click on this button is, and it used to leave a stray terminal behind.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let opened: number
let closed: number
/** Held so a press can land while the shell is still opening. */
let settle: () => void

const docked = (): TerminalView => ({
  kind: 'terminal',
  terminalId: 't1',
  runtime: runtimeId('claude'),
  cwd: '/repo',
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  opened = 0
  closed = 0
  settle = () => {}
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const mount = (terminals: readonly TerminalView[], withFolder = true): AppStore => {
  const base = emptySnapshot()
  // The shells live in the bottom panel now, docked the way anything is.
  const workbench = terminals.reduce((acc, view) => dock(acc, 'bottom', view), base.workbench)
  const snapshot: AppSnapshot = {
    ...base,
    workspace: withFolder ? { path: '/synthetic/project', name: 'Synthetic project', lastOpenedAt: 1 } : null,
    workbench,
    layout: workbench.main,
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    openTerminal: () => {
      opened += 1
      return new Promise<void>((resolve) => {
        settle = resolve
      })
    },
    closeTerminalDock: () => {
      closed += 1
    },
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TerminalToggle />
      </StoreProvider>,
    )
  })
  return store
}

const button = (): HTMLButtonElement => {
  const found = container.querySelector('button')
  if (!found) throw new Error('no terminal button')
  return found
}

const press = (): void => {
  act(() => {
    button().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

it('opens a terminal when the dock is empty', () => {
  mount([])
  expect(button().getAttribute('aria-label')).toBe('Open terminal')
  press()
  expect([opened, closed]).toEqual([1, 0])
})

it('does not open a terminal when work has no folder', () => {
  mount([], false)
  expect(button().getAttribute('aria-label')).toBe('Open terminal')
  press()
  expect([opened, closed]).toEqual([0, 0])
})

it('closes the dock instead of opening a second shell', () => {
  mount([docked()])
  expect(button().getAttribute('aria-label')).toBe('Close terminal')
  press()
  expect([opened, closed]).toEqual([0, 1])
})

it('reads a still-opening shell as on, so a double click closes it', async () => {
  mount([])
  press()
  // The runtime has not answered yet — the snapshot's dock is still empty.
  expect(button().getAttribute('aria-label')).toBe('Close terminal')
  press()
  expect([opened, closed]).toEqual([1, 1])
  // Let the cancelled open settle, so the state it drops lands inside act.
  await act(async () => {
    settle()
  })
})

it('old settlement cannot clear a newer pending operation, including a remounted toggle', async () => {
  const store = mount([])
  press()
  const old = settle
  press() // Cancel first.
  press() // Request another.
  const current = settle
  await act(async () => old())
  expect(button().getAttribute('aria-label')).toBe('Close terminal')
  act(() => root.render(null))
  act(() => root.render(<StoreProvider store={store}><TerminalToggle /></StoreProvider>))
  expect(button().getAttribute('aria-label')).toBe('Close terminal')
  press()
  expect([opened, closed]).toEqual([2, 2])
  await act(async () => current())
  expect(button().getAttribute('aria-label')).toBe('Open terminal')
})

it('actual cancellation closes arriving PTYs without attaching or changing the work', async () => {
  vi.stubGlobal('innerWidth', 1440); vi.stubGlobal('innerHeight', 900)
  const store = new AppStore('ws://localhost:0/')
  const pending: ((value: unknown) => void)[] = []
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'workspace/open') return { path: '/work/storefront', name: 'Storefront', lastOpenedAt: 1 }
    if (method === 'terminal/open') return await new Promise(resolve => pending.push(resolve))
    return null
  }) as never)
  try {
    await store.selectRuntime(runtimeId('fixture'))
    await store.openWorkspace('/work/storefront')
    store.showViewIn('right', { kind: 'file', path: '/work/storefront/lib/brands.ts', runtime: runtimeId('fixture') })
    const main = store.getSnapshot().workbench.main
    const right = dockViews(store.getSnapshot().workbench.right)
    act(() => root.render(<StoreProvider store={store}><TerminalToggle /></StoreProvider>))
    press(); press(); press()
    await act(async () => { pending[0]!({ terminalId: 'canceled-first', runtime: runtimeId('fixture') }) })
    expect(button().getAttribute('aria-label')).toBe('Close terminal')
    act(() => root.render(null))
    act(() => root.render(<StoreProvider store={store}><TerminalToggle /></StoreProvider>))
    press()
    await act(async () => { pending[1]!({ terminalId: 'canceled-second', runtime: runtimeId('fixture') }) })
    expect(request.mock.calls.filter(([method]) => method === 'terminal/close').map(([, params]) => params)).toEqual([
      { terminalId: 'canceled-first' }, { terminalId: 'canceled-second' },
    ])
    expect(dockViews(store.getSnapshot().workbench.bottom)).toHaveLength(0)
    expect(store.getSnapshot().workbench.main).toBe(main)
    expect(dockViews(store.getSnapshot().workbench.right)).toEqual(right)
    expect(button().getAttribute('aria-label')).toBe('Open terminal')
  } finally { request.mockRestore(); vi.unstubAllGlobals() }
})

it('the keyboard toggle preserves retained shells on folderless pages', () => {
  const store = mount([docked()], false)
  Object.assign(store.getSnapshot().workbench, { navigation: { current: { kind: 'settings', route: { kind: 'section', section: 'general', focus: null } }, back: [], forward: [] } })
  act(() => toggleTerminal(store))
  expect([opened, closed]).toEqual([0, 0])
})
it('the keyboard toggle opens a shell in the project chosen on a page', () => {
  const store = mount([])
  Object.assign(store.getSnapshot().workbench, { navigation: { current: { kind: 'dashboard', view: 'overview', scope: null }, back: [], forward: [] } })
  act(() => toggleTerminal(store))
  expect([opened, closed]).toEqual([1, 0])
})

it('More omits Terminal on folderless pages even with retained shells', () => {
  const store = mount([docked()], false)
  Object.assign(store.getSnapshot().workbench, { navigation: { current: { kind: 'agents' }, back: [], forward: [] } })
  act(() => root.render(<StoreProvider store={store}><Menu close={() => {}}><TerminalMenuItem close={() => {}} /></Menu></StoreProvider>))
  expect(container.querySelector('[role="menuitemradio"]')).toBeNull()
})
