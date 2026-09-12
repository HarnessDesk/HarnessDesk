import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Worktree, WorktreeChanges } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { RemoveWorktree } from './RemoveWorktree'

/**
 * Removing a worktree — the one dialog that ever sends `force`. What it must
 * never do is send it without first having named every file it would discard,
 * and what it must never offer is a removal it could not read the cost of.
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

const TREE: Worktree = {
  path: '/state/worktrees/repo-1a/parser',
  branch: 'harnessdesk/parser',
  head: 'b',
  isMain: false,
  managed: true,
}

const rig = async (changes: WorktreeChanges | Error) => {
  const snapshot = { ...emptySnapshot(), status: 'open' } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: {
      request: vi.fn(async () => {
        if (changes instanceof Error) throw changes
        return changes
      }),
    },
    removeWorktree: vi.fn(async () => true),
  } as unknown as AppStore
  const onClose = vi.fn()
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <RemoveWorktree worktree={TREE} onClose={onClose} />
      </StoreProvider>,
    )
  })
  return { store, onClose }
}

const button = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === text)

it('removes a clean worktree without asking to discard anything', async () => {
  const { store, onClose } = await rig({ modified: 0, untracked: 0, unpushedCommits: 1, files: [], ignored: [], ignoredCount: 0 })

  const text = document.body.textContent ?? ''
  expect(text).toContain('Nothing uncommitted. 1 commit on the branch has not been pushed; the branch keeps it.')
  await act(async () => button('Remove worktree')!.click())

  expect(store.removeWorktree).toHaveBeenCalledWith(TREE.path, false)
  expect(onClose).toHaveBeenCalled()
})

it('names every file a removal would discard before it offers to discard them', async () => {
  const { store } = await rig({ modified: 1, untracked: 1, unpushedCommits: 0, files: ['src/parser.ts', 'notes.md'], ignored: [], ignoredCount: 0 })

  const text = document.body.textContent ?? ''
  expect(text).toContain('This would discard 1 modified and 1 untracked files')
  expect(text).toContain('src/parser.ts')
  expect(text).toContain('notes.md')
  expect(button('Remove worktree')).toBeUndefined()

  await act(async () => button('Discard changes and remove')!.click())
  expect(store.removeWorktree).toHaveBeenCalledWith(TREE.path, true)
})

it('says what it could not read, and offers nothing it cannot back', async () => {
  const { store } = await rig(new Error('not a git repository'))

  expect(document.body.textContent).toContain('not a git repository')
  expect(button('Remove worktree')?.disabled).toBe(true)
  expect(store.removeWorktree).not.toHaveBeenCalled()
})

it('names what git ignores before it deletes the folder, and tells a file from a rebuildable folder', async () => {
  /* #209: `git status` counts none of this, so the dialog said "only the
     checkout goes" over a folder holding an `.env` that was never in git —
     which `git worktree remove` deletes without being forced. */
  const { store } = await rig({
    modified: 0,
    untracked: 0,
    unpushedCommits: 0,
    files: [],
    ignored: ['.env', 'node_modules/'],
    ignoredCount: 2,
  })

  const text = document.body.textContent ?? ''
  expect(text).toContain('the folder goes, with anything git ignores in it')
  expect(text).toContain('This also deletes 1 file and 1 folder git ignores here')
  expect(text).toContain('.env')
  expect(text).toContain('node_modules/')
  expect(text).toContain('.env is not in git, so nothing can put it back')
  expect(text).toContain('can be built again')
  // The controls: nothing is uncommitted, so this is still the plain removal
  // with no force — ignored files are named, not treated as a refusal.
  expect(text).toContain('Nothing uncommitted.')
  await act(async () => button('Remove worktree')!.click())
  expect(store.removeWorktree).toHaveBeenCalledWith(TREE.path, false)
})

it('says nothing about ignored files when git ignores nothing here', async () => {
  await rig({ modified: 0, untracked: 0, unpushedCommits: 0, files: [], ignored: [], ignoredCount: 0 })

  expect(document.body.textContent).not.toContain('git ignores here')
})
