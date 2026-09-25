import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import type { ProjectGroup } from '../lib/projects'
import { WorkspaceMenu } from './WorkspaceMenu'

/**
 * A project's Move rows are the sidebar's keyboard route through its arranged
 * run: the sortable part's `move`, said out loud in the part's own words once
 * the store has answered, beside the menu rather than inside it.
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

const group = (root: string, name: string): ProjectGroup => ({ root, name, sessions: [], updatedAt: 0 })

/** A store that answers a move the way the real one does: the pinned run is the order. */
const mount = (pinned: string[], subject: ProjectGroup) => {
  let snapshot = { ...emptySnapshot(), listPrefs: { ...emptySnapshot().listPrefs, pinned } } as AppSnapshot
  const listeners = new Set<() => void>()
  const store = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    moveProject: vi.fn((root: string, to: number) => {
      const rest = snapshot.listPrefs.pinned.filter((entry) => entry !== root)
      const next = to < 0 || to > rest.length ? rest : [...rest.slice(0, to), root, ...rest.slice(to)]
      snapshot = { ...snapshot, listPrefs: { ...snapshot.listPrefs, pinned: next } }
      for (const listener of listeners) listener()
    }),
  } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <WorkspaceMenu group={subject} at={{ x: 10, y: 10 }} onClose={() => {}} onNewWorktree={() => {}} />
    </StoreProvider>,
  ))
  return store
}

const row = (label: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((one) => one.textContent?.startsWith(label))
  if (!found) throw new Error(`no ${label} row`)
  return found
}
const said = (): string => container.querySelector('[data-slot="sortable-announcer"]')?.textContent ?? ''

it('announces a move up as a place in the arranged run', () => {
  const store = mount(['/a', '/b', '/c'], group('/b', 'billing'))
  act(() => row('Move up').click())
  expect(store.moveProject).toHaveBeenCalledWith('/b', 0)
  expect(said()).toBe('Moved billing to position 1 of 3')
  // The sentence is not a menu item: it sits beside the menu.
  expect(document.querySelector('[role="menu"] [data-slot="sortable-announcer"]')).toBeNull()
})

it('announces the last project moving down as leaving the run for the sort', () => {
  const store = mount(['/a', '/b'], group('/b', 'billing'))
  act(() => row('Move down').click())
  expect(store.moveProject).toHaveBeenCalledWith('/b', 2)
  expect(said()).toBe('billing is back in automatic order')
})

it('says nothing when the store has not moved anything', () => {
  const snapshot = { ...emptySnapshot(), listPrefs: { ...emptySnapshot().listPrefs, pinned: ['/a', '/b'] } } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, moveProject: vi.fn() } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <WorkspaceMenu group={group('/b', 'billing')} at={{ x: 10, y: 10 }} onClose={() => {}} onNewWorktree={() => {}} />
    </StoreProvider>,
  ))
  act(() => row('Move up').click())
  expect(store.moveProject).toHaveBeenCalledWith('/b', 0)
  expect(said()).toBe('')
})
