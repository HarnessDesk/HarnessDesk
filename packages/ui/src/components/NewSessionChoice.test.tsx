import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { NewSessionChoice } from './NewSessionChoice'

/**
 * The entry point for the collaborative half of the product.
 *
 * "New session" made a solo draft and a Room appeared later, once agents
 * happened to be in the folder — so somebody who came to run three agents on
 * one repository had no way to say so, and the Room was something you
 * discovered rather than chose.
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

const rig = (
  history: readonly { cwd: string; archived?: boolean; repo?: unknown }[] = [],
  over: { workspace?: unknown; teams?: Map<string, unknown> } = {},
) => {
  const open = over.workspace ?? { path: '/repo', name: 'repo', lastOpenedAt: 1 }
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspace: open,
    workspaces: [open],
    history,
    ...(over.teams ? { teams: over.teams } : {}),
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    newDraft: vi.fn(),
    openTeamRoom: vi.fn(),
    createRoom: vi.fn().mockResolvedValue('r1'),
    /* A project with no flows: the picker says so and the dialog is the
       dialog it has always been, which is what every test below asserts. */
    listFlows: vi.fn().mockResolvedValue([]),
    readFlow: vi.fn(),
    dryRunFlow: vi.fn(),
    startFlow: vi.fn(),
  } as unknown as AppStore
  return { store }
}

const render = (store: AppStore, onClose = vi.fn()): typeof onClose => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <NewSessionChoice onClose={onClose} />
      </StoreProvider>,
    )
  })
  return onClose
}

const choice = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((one) =>
    one.textContent?.includes(name),
  )
  if (!found) throw new Error(`no choice named ${name}`)
  return found
}

it('offers both shapes of work, and starting a session is still a draft', () => {
  const { store } = rig()
  const onClose = render(store)

  act(() => choice('A session').click())
  expect(store.newDraft).toHaveBeenCalledTimes(1)
  expect(store.openTeamRoom).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

it('asks for the room’s name, and creates it under the open project', async () => {
  /* Picking "A room" used to call `openTeamRoom(root)`, which opened a surface
     keyed by the folder that had never been created: nothing was written,
     nothing appeared in the tree, and the next launch had no memory of it. A
     project holds several rooms, so the folder cannot name one — and an
     unnamed room is a row nobody can tell from the row above it. */
  const { store } = rig()
  const onClose = render(store)

  act(() => choice('A room').click())
  expect(store.createRoom).not.toHaveBeenCalled()

  const field = document.querySelector<HTMLInputElement>('[aria-label="Room name"]')
  if (!field) throw new Error('the name was never asked for')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      field,
      'Checkout rewrite',
    )
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => choice('Create room').click())
  await act(async () => {
    await Promise.resolve()
  })

  expect(store.createRoom).toHaveBeenCalledWith('/repo', 'Checkout rewrite')
  expect(store.newDraft).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

it('a room made from a worktree is keyed by the project it belongs to', async () => {
  /* The count above already used the project root; this used `workspace.path`
     directly. From a linked worktree the two disagreed, and the room was made
     under a folder `SessionTree` never looks up — present on disk, absent
     from its own project's tree the moment the dialog closed. */
  const { store } = rig()
  const snapshot = store.getSnapshot() as unknown as { workspace: unknown }
  snapshot.workspace = {
    path: '/repo/.worktrees/feature',
    name: 'feature',
    lastOpenedAt: 1,
    repo: { root: '/repo', worktree: true },
  }
  render(store)

  act(() => choice('A room').click())
  const field = document.querySelector<HTMLInputElement>('[aria-label="Room name"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Auth')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => choice('Create room').click())
  await act(async () => {
    await Promise.resolve()
  })

  expect(store.createRoom).toHaveBeenCalledWith('/repo', 'Auth')
})

it('will not create a room with no name', () => {
  const { store } = rig()
  render(store)
  act(() => choice('A room').click())
  expect(choice('Create room').disabled).toBe(true)
})

it('keeps the name and says why when the host will not make the room', async () => {
  const { store } = rig()
  ;(store.createRoom as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('That project is not open any more.'),
  )
  const onClose = render(store)

  act(() => choice('A room').click())
  const field = document.querySelector<HTMLInputElement>('[aria-label="Room name"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Auth')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => choice('Create room').click())
  await act(async () => {
    await Promise.resolve()
  })

  expect(onClose).not.toHaveBeenCalled()
  expect(container.textContent).toContain('not open any more')
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="Room name"]')?.value,
  ).toBe('Auth')
})

it('counts what the sidebar counts when it is filtered to one agent', () => {
  // `SessionTree` filters history by `listPrefs.agent` *before* grouping. This
  // dialog grouped the whole history, so with the list narrowed to one agent
  // the tree said 1 and the option beneath it said 2.
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 },
    workspaces: [{ path: '/repo' }],
    listPrefs: { ...emptySnapshot().listPrefs, agent: 'codex' },
    runtimes: [
      { id: 'codex', presentation: { name: 'Codex' }, capabilities: {} },
      { id: 'cursor', presentation: { name: 'Cursor' }, capabilities: {} },
    ],
    history: [
      { cwd: '/repo', runtime: 'codex', repo: { root: '/repo' } },
      { cwd: '/repo', runtime: 'cursor', repo: { root: '/repo' } },
    ],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    newDraft: vi.fn(),
    openTeamRoom: vi.fn(),
  } as unknown as AppStore
  render(store)
  expect(choice('A room').textContent).toContain('1 conversation is already')
})

it('counts a subfolder the way the sidebar folds it', () => {
  // `groupByProject` folds a repository root, its subfolders and its worktrees
  // into one project. A path-prefix filter does not: with `/repo/packages/ui`
  // open, the sidebar counted two and this dialog counted one, directly
  // beneath it.
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspace: { path: '/repo/packages/ui', name: 'ui', lastOpenedAt: 1 },
    workspaces: [{ path: '/repo/packages/ui' }],
    history: [
      { cwd: '/repo/packages/ui', repo: { root: '/repo' } },
      { cwd: '/repo', repo: { root: '/repo' } },
    ],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    newDraft: vi.fn(),
    openTeamRoom: vi.fn(),
  } as unknown as AppStore
  render(store)
  expect(choice('A room').textContent).toContain('2 conversations are already')
})

it('says how many conversations are already in the folder', () => {
  // A room is not created — it is the board this folder already has — so the
  // option describes what is there rather than promising to make something.
  // Counted the way the sidebar counts, or the dialog contradicts the tree
  // directly above it — which it did, saying three over a folder marked two.
  const { store } = rig([
    { cwd: '/repo' },
    { cwd: '/repo/packages/ui' },
    { cwd: '/repo', archived: true },
    { cwd: '/elsewhere' },
  ])
  render(store)
  expect(choice('A room').textContent).toContain('2 conversations are already')
})

it('cannot open a room with no folder open', () => {
  const snapshot = { ...emptySnapshot(), status: 'open' } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    newDraft: vi.fn(),
    openTeamRoom: vi.fn(),
  } as unknown as AppStore
  render(store)
  expect(choice('A room').disabled).toBe(true)
})

it('counts the rooms a project already has when the folder you have open is a subfolder', () => {
  /* `projectRootOf` names the subfolder, the host keys the room it makes at
     the repository above it, and comparing those as strings told somebody
     standing in `packages/ui` that their project had no rooms — then offered
     to make a second one with no way to tell it from the first. */
  const sub = '/repo/packages/ui'
  const repo = { root: '/repo', worktree: false }
  const { store } = rig([{ cwd: sub, repo }], {
    workspace: { path: sub, name: 'ui', lastOpenedAt: 1, repo },
    teams: new Map([
      ['r1', { id: 'r1', name: 'Checkout rewrite', root: '/repo', members: [], intents: [], channel: [] }],
    ]),
  })
  render(store)
  act(() => choice('A room').click())
  const note = [...container.querySelectorAll('p')].find((one) =>
    one.textContent?.includes('room'),
  )
  expect(note?.textContent).toContain('One room already in this project: Checkout rewrite')
})
