import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { NewWorktree } from './NewWorktree'

/**
 * The dialog behind "New worktree…".
 *
 * The two things it exists to carry are the name and the branch it starts
 * from; the button it replaced could carry neither. So the tests are about
 * exactly those two reaching `newSession`, and about the name never
 * promising a branch git would not accept.
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

const rig = ({ open = true }: { open?: boolean } = {}) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspaces: open ? [{ path: '/repos/harness-desk', name: 'harness-desk', lastOpenedAt: 1 }] : [],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    newSession: vi.fn().mockResolvedValue('agent:new'),
    openWorkspace: vi.fn().mockResolvedValue(undefined),
    listBranches: vi.fn().mockResolvedValue([
      { name: 'main', current: true, committedAt: 2 },
      { name: 'feat/docs', current: false, committedAt: 1 },
    ]),
  } as unknown as AppStore
  return { store }
}

const render = async (store: AppStore): Promise<void> => {
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <NewWorktree root="/repos/harness-desk" onClose={() => {}} />
      </StoreProvider>,
    )
  })
}

const button = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((entry) => entry.textContent === text)
  if (!found) throw new Error(`no button labelled ${text}`)
  return found
}

const type = async (text: string): Promise<void> => {
  const field = document.querySelector('input')
  if (!field) throw new Error('no name field')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('starts from the branch you are on unless you pick another', async () => {
  const { store } = rig()
  await render(store)
  await type('parser fix')

  await act(async () => button('Create worktree').click())

  expect(store.newSession).toHaveBeenCalledWith({
    cwd: '/repos/harness-desk',
    worktree: 'parser fix',
    base: 'main',
  })
})

it('sends the branch that was picked', async () => {
  const { store } = rig()
  await render(store)
  await type('parser fix')

  await act(async () => button('feat/docs').click())
  await act(async () => button('Create worktree').click())

  expect(store.newSession).toHaveBeenCalledWith(
    expect.objectContaining({ base: 'feat/docs' }),
  )
})

it('shows the branch the name will really become', async () => {
  const { store } = rig()
  await render(store)

  await type('Fix The Thing!')

  expect(document.body.textContent).toContain('harnessdesk/fix-the-thing')
})

it('names the project it is about, with enough path to tell two apart', async () => {
  const { store } = rig()
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        {/* A path deep enough that the strip has to trim it. Two checkouts of
            one repository have the same folder name, which is the whole
            reason the path is here. */}
        <NewWorktree root="/Users/me/.harnessdesk/worktrees/harness-desk-7ae59f/parser" onClose={() => {}} />
      </StoreProvider>,
    )
  })

  const strip = [...document.querySelectorAll<HTMLElement>('[title]')].find(
    (element) => element.title.startsWith('/Users/me/.harnessdesk'),
  )
  // Trimmed from the front, so the half that distinguishes it survives; and
  // the last segment is its own element, because it is the one the
  // stylesheet must never be allowed to shorten.
  expect(strip?.textContent?.startsWith('…/worktrees/harness-desk-7ae59f/parser')).toBe(true)
  expect([...(strip?.children ?? [])].some((child) => child.textContent === 'parser')).toBe(true)
  expect(strip?.title).toBe('/Users/me/.harnessdesk/worktrees/harness-desk-7ae59f/parser')
})

it('opens a project it is not already in, and says so before you commit', async () => {
  const { store } = rig({ open: false })
  await render(store)

  expect(document.body.textContent).toContain('opens this folder first')

  await type('parser fix')
  await act(async () => button('Create worktree').click())

  expect(store.openWorkspace).toHaveBeenCalledWith('/repos/harness-desk')
  expect(store.newSession).toHaveBeenCalled()
})

it('leaves the workspace alone when the project is already open', async () => {
  const { store } = rig()
  await render(store)

  expect(document.body.textContent).not.toContain('opens this folder first')

  await type('parser fix')
  await act(async () => button('Create worktree').click())

  expect(store.openWorkspace).not.toHaveBeenCalled()
})

it('waits to be typed in before it says anything is wrong', async () => {
  const { store } = rig()
  await render(store)

  expect(button('Create worktree').disabled).toBe(true)
  expect(document.body.textContent).not.toContain('Give it a name.')

  await type('///')

  expect(button('Create worktree').disabled).toBe(true)
  expect(document.body.textContent).toContain('Give it a name.')
})
