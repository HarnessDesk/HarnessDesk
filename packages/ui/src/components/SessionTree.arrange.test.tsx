import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeInfo, SessionSummary } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SessionListControls, SessionTree } from './SessionTree'

/**
 * Arranging the project list: folding it, and putting the projects where you
 * want them.
 *
 * Both write to preferences rather than to component state, because both are
 * work a person does once and expects to still be true tomorrow. These tests
 * hold that line at the seam — what the list asks the store for — since the
 * folding survived a re-render perfectly well when it was local state and
 * still lost everything on restart.
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

const runtime = {
  id: 'agent',
  name: 'Agent',
  capabilities: { deleteHistory: true },
  presentation: { name: 'Agent' },
} as unknown as RuntimeInfo

const session = (id: string, cwd: string, at: number): SessionSummary =>
  ({
    id,
    runtime: runtime.id,
    title: id,
    preview: null,
    cwd,
    git: { originUrl: `https://example.test/${cwd.split('/').at(-1)}`, branch: 'main' },
    status: { type: 'notLoaded' },
    createdAt: at,
    updatedAt: at,
    archived: false,
  }) as unknown as SessionSummary

/** Three projects, all pinned, so all three are in the arranged run. */
const rig = (patch: Partial<AppSnapshot['listPrefs']> = {}) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    history: [session('a', '/one', 3), session('b', '/two', 2), session('c', '/three', 1)],
    listPrefs: { ...emptySnapshot().listPrefs, pinned: ['/one', '/two', '/three'], ...patch },
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    setListPrefs: vi.fn(),
    setProjectsCollapsed: vi.fn(),
    toggleProjectCollapsed: vi.fn(),
    moveProject: vi.fn(),
    setOthersOpen: vi.fn(),
  } as unknown as AppStore
  return { snapshot, store }
}

const heads = (): HTMLElement[] =>
  [...container.querySelectorAll<HTMLElement>('[draggable="true"]')]

it('puts a pinned project mark in the row trailing slot beside its label', () => {
  const { store } = rig()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={4} />
      </StoreProvider>,
    )
  })
  const head = heads()[0]
  const label = head?.querySelector('[data-slot="sidebar-menu-label"]')
  const pin = head?.querySelector('[data-sidebar="menu-badge"][aria-label="Pinned"]')
  expect(pin).not.toBeNull()
  expect(label?.contains(pin!)).toBe(false)
})

/** A drag event jsdom will carry a dataTransfer on. */
const dragEvent = (type: string, clientY: number): DragEvent => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', {
    value: { setData: () => {}, getData: () => '', effectAllowed: '', dropEffect: '' },
  })
  return event
}

it('drops a project into the place it was dropped, and keeps the rest in order', () => {
  const { store } = rig()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={4} />
      </StoreProvider>,
    )
  })

  const [first, , third] = heads()
  if (!first || !third) throw new Error('project rows did not render')
  // jsdom gives every element a zero-size box, so "above the middle" is any
  // clientY below 0 — which is what a drop on the row's top half means here.
  act(() => {
    first.dispatchEvent(dragEvent('dragstart', 0))
  })
  act(() => {
    third.dispatchEvent(dragEvent('dragover', -1))
  })
  act(() => {
    third.dispatchEvent(dragEvent('drop', -1))
  })

  expect(store.setListPrefs).toHaveBeenCalledWith({ pinned: ['/two', '/one', '/three'] })
})

it('leaves alone the projects the drag was not about', () => {
  // /one and /three are arranged; /two is in the same run only because it is
  // the folder that happens to be open; /gone is arranged but has no sessions
  // left, so it has no row at all. Dragging /three must move /three, must not
  // sweep /two into the run behind the user's back, and must not cost /gone
  // its place.
  const { snapshot, store } = rig({ pinned: ['/one', '/three', '/gone'] })
  const withCurrent = {
    ...snapshot,
    history: [...snapshot.history, session('d', '/four', 0)],
    workspace: { path: '/two' },
  } as unknown as AppSnapshot
  const store2 = { ...store, getSnapshot: () => withCurrent } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store2}>
        <SessionTree now={5} />
      </StoreProvider>,
    )
  })

  const rows = heads()
  const [first, , third] = rows
  if (rows.length !== 3 || !first || !third) {
    throw new Error(`expected three arranged rows, got ${rows.length}`)
  }
  act(() => {
    third.dispatchEvent(dragEvent('dragstart', 0))
  })
  act(() => {
    first.dispatchEvent(dragEvent('dragover', -1))
  })
  act(() => {
    first.dispatchEvent(dragEvent('drop', -1))
  })

  expect(store2.setListPrefs).toHaveBeenCalledWith({ pinned: ['/three', '/one', '/gone'] })
})

it('hands a project back to the sort when it is dropped on the fold', () => {
  // Four projects and only two pinned, so the other two fold away and the
  // "Other projects" row — the drop target for unpinning — exists.
  const { snapshot, store } = rig({ pinned: ['/one', '/two'] })
  const history = [
    ...snapshot.history,
    session('d', '/four', 0),
  ]
  const withFour = { ...snapshot, history } as AppSnapshot
  const store2 = { ...store, getSnapshot: () => withFour } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store2}>
        <SessionTree now={4} />
      </StoreProvider>,
    )
  })

  const [first] = heads()
  const fold = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.startsWith('Other projects'),
  )
  if (!first || !fold) throw new Error('the list did not render a fold to drop on')

  act(() => {
    first.dispatchEvent(dragEvent('dragstart', 0))
  })
  act(() => {
    fold.dispatchEvent(dragEvent('drop', 0))
  })

  expect(store2.moveProject).toHaveBeenCalledWith('/one', -1)
})

it('folds every project the list is showing, not just the ones on screen', () => {
  const { store } = rig()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionListControls />
      </StoreProvider>,
    )
  })

  const trigger = container.querySelector('button')
  if (!trigger) throw new Error('the controls did not render')
  act(() => trigger.click())

  const collapse = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent?.startsWith('Collapse all'),
  )
  if (!collapse) throw new Error('Collapse all did not render')
  act(() => collapse.click())

  expect(store.setProjectsCollapsed).toHaveBeenCalledWith(
    expect.arrayContaining(['/one', '/two', '/three']),
    true,
  )
})

it('expands a project folded under a clone while the agent filter delays migration', () => {
  const home = '/widgets'
  const clone = '/widgets-clone'
  const repository = (root: string) => ({ root, worktree: false, origin: 'github.com/acme/widgets' })
  const { snapshot, store } = rig({ agent: runtime.id, collapsed: [clone], pinned: [] })
  let currentSnapshot = {
    ...snapshot,
    history: [
      { ...session('home-session', home, 1), repo: repository(home) },
      { ...session('clone-session', clone, 2), repo: repository(clone) },
    ],
  } as AppSnapshot
  const listeners = new Set<() => void>()
  const liveStore = {
    ...store,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => currentSnapshot,
    setProjectsCollapsed: vi.fn((folders: readonly string[], collapsed: boolean) => {
      const current = currentSnapshot.listPrefs.collapsed
      currentSnapshot = {
        ...currentSnapshot,
        listPrefs: {
          ...currentSnapshot.listPrefs,
          collapsed: collapsed
            ? [...new Set([...current, ...folders])]
            : current.filter((folder) => !folders.includes(folder)),
        },
      }
      listeners.forEach((listener) => listener())
    }),
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={liveStore}>
        <SessionListControls />
        <SessionTree now={4} />
      </StoreProvider>,
    )
  })

  expect(container.textContent).not.toContain('clone-session')

  const trigger = container.querySelector<HTMLButtonElement>('button[title="How this list is shown"]')
  if (!trigger) throw new Error('the display controls did not render')
  act(() => trigger.click())

  const expand = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent?.startsWith('Expand all'),
  )
  if (!expand) throw new Error('Expand all did not render')
  act(() => expand.click())

  expect(liveStore.setProjectsCollapsed).toHaveBeenCalledWith([home, clone], false)
  expect(container.textContent).toContain('clone-session')
})

const openControlSubmenu = async (name: string): Promise<HTMLElement> => {
  const trigger = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((item) => item.querySelector('[class*="title"]')?.textContent?.trim() === name)
  if (!trigger) throw new Error(`the ${name} submenu did not render`)
  act(() => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  return trigger
}

it('keeps display controls to three flyouts and the project fold actions', () => {
  const { store } = rig()
  act(() => root.render(<StoreProvider store={store}><SessionListControls /></StoreProvider>))
  const trigger = container.querySelector('button')!
  act(() => trigger.click())
  const menu = document.querySelector('[role="menu"]')!
  const labels = [...menu.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]')]
    .map((item) => item.querySelector('[class*="title"]')?.textContent?.trim())
  expect(labels).toEqual(['Sort projects', 'Density', 'Show agents', 'Collapse all', 'Expand all'])
  expect(menu.querySelectorAll(':scope > [role="menuitem"]')).toHaveLength(5)
  expect(menu.querySelector('[role="separator"]')).not.toBeNull()
  expect(container.querySelector('[data-filtered]')).toBeNull()
})

it('keeps the filter dot on the display trigger while an agent filter hides rows', () => {
  const { store } = rig({ agent: runtime.id })
  act(() => root.render(<StoreProvider store={store}><SessionListControls /></StoreProvider>))
  const controls = container.querySelector('[data-filtered]')!
  expect(controls.querySelector('[aria-hidden="true"]')).not.toBeNull()
  expect(controls.querySelector('button[title="How this list is shown"]')).not.toBeNull()
})

it('sorts projects and changes density only through their flyouts', async () => {
  const { store } = rig()
  act(() => root.render(<StoreProvider store={store}><SessionListControls /></StoreProvider>))
  act(() => container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await openControlSubmenu('Sort projects')
  const name = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    .find((item) => item.querySelector('[class*="title"]')?.textContent?.trim() === 'Name')!
  act(() => name.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(store.setListPrefs).toHaveBeenCalledWith({ sort: 'name' })

  act(() => container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await openControlSubmenu('Density')
  const compact = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    .find((item) => item.querySelector('[class*="title"]')?.textContent?.trim() === 'Compact')!
  act(() => compact.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(store.setListPrefs).toHaveBeenCalledWith({ density: 'compact', densityPicked: true })
})

it('shows every runtime in the Show agents flyout and filters by the chosen runtime', async () => {
  const more = { ...runtime, id: 'other', presentation: { name: 'Other Agent' } } as RuntimeInfo
  const { snapshot, store } = rig()
  const nextSnapshot = { ...snapshot, runtimes: [runtime, more] } as AppSnapshot
  const storeWithRuntimes = { ...store, getSnapshot: () => nextSnapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={storeWithRuntimes}><SessionListControls /></StoreProvider>))
  act(() => container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await openControlSubmenu('Show agents')
  const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
  const labels = [...menus[1]!.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    .map((item) => item.querySelector('[class*="title"]')?.textContent?.trim())
  expect(labels).toEqual(['All agents', 'Agent', 'Other Agent'])
  const other = [...menus[1]!.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    .find((item) => item.querySelector('[class*="title"]')?.textContent?.trim() === 'Other Agent')!
  act(() => other.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(storeWithRuntimes.setListPrefs).toHaveBeenCalledWith({ agent: 'other' })
})

it('reads which projects are folded from preferences, so a restart keeps them', () => {
  const { store } = rig({ collapsed: ['/one', '/two', '/three'] })
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={4} />
      </StoreProvider>,
    )
  })

  // Folded means the sessions inside are not rendered at all.
  const titles = [...container.querySelectorAll('button')].map((button) => button.textContent)
  expect(titles).not.toContain('a')
  expect(titles).not.toContain('b')
})
