import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeInfo, Worktree, WorktreeChanges } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { BringHome } from './BringHome'

/**
 * Bringing a worktree back to the main checkout.
 *
 * What it must never do is offer the move while the worktree holds work that
 * the move would destroy; what it must always do is say, before anything
 * moves, which branch the main checkout leaves and which it takes.
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

const MAIN: Worktree = { path: '/code/repo', branch: 'main', head: 'a', isMain: true, managed: false }
const TREE: Worktree = {
  path: '/state/worktrees/repo-1a/parser',
  branch: 'harnessdesk/parser',
  head: 'b',
  isMain: false,
  managed: true,
}
const CLEAN: WorktreeChanges = { modified: 0, untracked: 0, unpushedCommits: 2, files: [] }

const rig = async ({
  changes = CLEAN,
  refusal = null,
  unread = null,
  mainChanges = CLEAN,
}: { changes?: WorktreeChanges; refusal?: string | null; unread?: string | null; mainChanges?: WorktreeChanges } = {}) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [{ id: 'codex', capabilities: {}, presentation: { name: 'Codex' } } as unknown as RuntimeInfo],
    activeRuntime: 'codex',
    worktrees: [MAIN, TREE],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: {
      request: vi.fn(async (_method: string, params: { path: string }) => {
        if (unread) throw new Error(unread)
        return params.path === MAIN.path ? mainChanges : changes
      }),
    },
    bringWorktreeHome: vi.fn(async () => refusal),
  } as unknown as AppStore
  const onClose = vi.fn()
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <BringHome worktree={TREE} onClose={onClose} />
      </StoreProvider>,
    )
  })
  return { store, onClose }
}

const button = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === text)

it('says which branch the main checkout leaves and which it takes, before anything moves', async () => {
  await rig()

  const text = document.body.textContent ?? ''
  expect(text).toContain('repo switches from main to harnessdesk/parser, with every commit made here.')
  expect(text).toContain(
    "The worktree's folder is removed, and with it anything git ignores there, such as an .env file or node_modules; the branch is not.",
  )
  expect(text).toContain('a new one opens in repo carrying what happened here')
  expect(button('Bring it back')).toBeDefined()
})

it('brings it back, and closes', async () => {
  const { store, onClose } = await rig()

  await act(async () => button('Bring it back')!.click())

  expect(store.bringWorktreeHome).toHaveBeenCalledWith(TREE.path)
  expect(onClose).toHaveBeenCalled()
})

it("stays open with git's own words when the main checkout will not take the switch", async () => {
  const said =
    'repo could not switch to harnessdesk/parser, so the worktree was left where it was. ' +
    'error: Your local changes to the following files would be overwritten by checkout: shared.txt'
  const { onClose } = await rig({ refusal: said })

  await act(async () => button('Bring it back')!.click())

  expect(document.querySelector('[role="alert"]')?.textContent).toBe(said)
  expect(onClose).not.toHaveBeenCalled()
})

it('does not offer the move while work is uncommitted, and offers the commit instead', async () => {
  const heard: unknown[] = []
  const listen = (event: Event): void => {
    heard.push((event as CustomEvent).detail)
  }
  window.addEventListener('harnessdesk:compose', listen)
  const { store, onClose } = await rig({
    changes: { modified: 1, untracked: 1, unpushedCommits: 0, files: ['src/parser.ts', 'notes.md'] },
  })

  const text = document.body.textContent ?? ''
  expect(button('Bring it back')).toBeUndefined()
  expect(text).toContain('1 modified and 1 untracked files not committed')
  expect(text).toContain('src/parser.ts')
  expect(text).toContain('notes.md')

  await act(async () => button('Ask Codex to commit them')!.click())
  window.removeEventListener('harnessdesk:compose', listen)

  // Into the composer to be read, not sent — and nothing moved.
  expect(heard).toHaveLength(1)
  expect(String(heard[0])).toContain('Commit the work in this worktree')
  expect(store.bringWorktreeHome).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

it('leaves it where it is when kept', async () => {
  const { store, onClose } = await rig()

  await act(async () => button('Keep it there')!.click())

  expect(onClose).toHaveBeenCalled()
  expect(store.bringWorktreeHome).not.toHaveBeenCalled()
})

it('says what it could not read, and offers no move it cannot back', async () => {
  await rig({ unread: 'fatal: not a git repository' })

  expect(document.body.textContent).toContain('fatal: not a git repository')
  expect(button('Bring it back')?.disabled).toBe(true)
})

it('says what the main checkout has not committed, since git carries it onto the branch', async () => {
  await rig({ mainChanges: { modified: 2, untracked: 0, unpushedCommits: 0, files: ['a.ts', 'b.ts'] } })

  expect(document.body.textContent).toContain(
    'repo has 2 modified files not committed. Git carries them onto harnessdesk/parser, or refuses the switch if they clash with it.',
  )
})
