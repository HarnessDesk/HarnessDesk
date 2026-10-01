import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import type { ProjectGroup } from '../lib/projects'
import type { SessionSummary } from '@harnessdesk/protocol'
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
  let snapshot = { ...emptySnapshot(), home: '/home/dev', listPrefs: { ...emptySnapshot().listPrefs, pinned } } as AppSnapshot
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
      <WorkspaceMenu
        group={subject}
        current={false}
        actualRoot={subject.root}
        at={{ x: 10, y: 10 }}
        onClose={() => {}}
        onNewWorktree={() => {}}
      />
    </StoreProvider>,
  ))
  return store
}

const row = (label: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((one) => one.textContent?.startsWith(label))
  if (!found) throw new Error(`no ${label} row`)
  return found
}
const moveRow = async (label: string): Promise<HTMLElement> => {
  const move = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((one) => one.querySelector('[class*="title"]')?.textContent?.trim() === 'Move')
  if (!move) throw new Error('no Move submenu')
  act(() => move.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  return row(label)
}
const said = (): string => container.querySelector('[data-slot="sortable-announcer"]')?.textContent ?? ''

it('announces a move up as a place in the arranged run', async () => {
  const store = mount(['/a', '/b', '/c'], group('/b', 'billing'))
  const up = await moveRow('Move up')
  act(() => up.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(store.moveProject).toHaveBeenCalledWith('/b', 0)
  expect(said()).toBe('Moved billing to position 1 of 3')
  // The sentence is not a menu item: it sits beside the menu.
  expect(document.querySelector('[role="menu"] [data-slot="sortable-announcer"]')).toBeNull()
})

it('moves the last project back into automatic order from the Move flyout', async () => {
  const store = mount(['/a', '/b'], group('/b', 'billing'))
  const back = await moveRow('Back to automatic order')
  act(() => back.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(store.moveProject).toHaveBeenCalledWith('/b', -1)
  expect(said()).toBe('billing is back in automatic order')
})

it('says nothing when the store has not moved anything', async () => {
  const snapshot = { ...emptySnapshot(), listPrefs: { ...emptySnapshot().listPrefs, pinned: ['/a', '/b'] } } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, moveProject: vi.fn() } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <WorkspaceMenu
        group={group('/b', 'billing')}
        current={false}
        actualRoot="/b"
        at={{ x: 10, y: 10 }}
        onClose={() => {}}
        onNewWorktree={() => {}}
      />
    </StoreProvider>,
  ))
  const up = await moveRow('Move up')
  act(() => up.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(store.moveProject).toHaveBeenCalledWith('/b', 0)
  expect(said()).toBe('')
})

it('groups project choices by task and puts movement in the Move flyout', async () => {
  const project = {
    ...group('/home/dev/work/project', 'project'),
    sessions: [{ id: 's', runtime: 'agent', title: 'Conversation', git: { branch: 'main' } } as unknown as SessionSummary],
  }
  mount(['/a', '/home/dev/work/project', '/other'], project)
  const menu = document.querySelector('[role="menu"]')!
  const labels = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.querySelector('[class*="title"]')?.textContent?.trim())
  expect(labels).toEqual([
    'New session here', 'New worktree…',
    'Open workspace', 'Open terminal here', 'History', 'Copy path', 'Project settings',
    'Unpin', 'Move',
    'Archive 1 session…', 'Remove project…',
  ])
  expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(3)
  const move = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === 'Move')!
  act(() => move.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  const allLabels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.querySelector('[class*="title"]')?.textContent?.trim())
  expect(allLabels).toContain('Move up')
  expect(allLabels).toContain('Move down')
  expect(allLabels).toContain('Back to automatic order')
})

it('keeps the first project Move up refusal reason in the flyout', async () => {
  const project = group('/first', 'first')
  mount(['/first', '/second'], project)
  const menu = document.querySelector('[role="menu"]')!
  const move = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((item) => item.querySelector('[class*="title"]')?.textContent?.trim() === 'Move')!
  act(() => move.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  const up = row('Move up')
  expect(up.getAttribute('aria-disabled')).toBe('true')
  expect(up.getAttribute('title')).toBe('Already first.')
})

it('shows a home-shortened path hint and copies the absolute project path', async () => {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const absolute = '/home/dev/work/project'
  mount([], group(absolute, 'project'))
  const path = row('Copy path')
  expect(path.querySelector('[class*="hint"]')?.textContent).toBe('~/work/project')
  act(() => path.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(writeText).toHaveBeenCalledWith(absolute)
})
