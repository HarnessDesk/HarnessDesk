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
